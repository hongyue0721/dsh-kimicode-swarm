#!/usr/bin/env python3
"""
Fix legacy session logs that contain the dsh-swarm 'swarm/progress' event.

Why: rc.8's session reader refuses to interpret a log whose event type is
outside the harness vocabulary unless the event carries `ignorable: true`.
The old dsh-swarm plugin wrote `swarm/progress` progress snapshots into the
session log without that marker, so every such session is unreadable.

The event is display-only (live per-subagent status while a batch runs), so
marking it ignorable is exactly the contract rc.8 defines: a reader may
safely skip it, and skipping it cannot change how the rest of the log is
reconstructed.

Physical format: rc.8 writes a CONCATENATED-FRAME zstd container — the header
record owns the first frame (and must be exactly one line there), then every
durable batch is its own independent, checksummed frame. A naive
whole-file `zstd -q` rewrite fuses everything into one frame, and the reader
rejects the log because the first frame is no longer exactly one header line.
This script therefore edits frame by frame: untouched frames are kept
byte-identical, only frames containing target events are decompressed, fixed,
and recompressed (checksummed) — preserving the frame boundaries the reader
relies on.

Only `swarm/progress` events are touched; every other event is passed
through byte-identical. The original files are backed up before rewriting.

Usage: python3 fix-swarm-progress-logs.py [sessions-root] [--dry-run]
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

SESSIONS_ROOT = os.path.expanduser('~/.dsh/sessions')
TARGET_TYPE = 'swarm/progress'
LOG_NAME = 'session.jsonl.zstd'

# Zstandard frame magic (little-endian 0xFD2FB528).
ZSTD_MAGIC = 4247762216


def decompress(data):
    return subprocess.run(['zstd', '-dc'], input=data, check=True, capture_output=True).stdout


def compress(data):
    # --check matches the harness's checksummed frames; without it the frame
    # is still decodable, but keep the artifact in the exact writer format.
    return subprocess.run(['zstd', '-q', '--check'], input=data, check=True, capture_output=True).stdout


def scan_zstd_frames(data):
    """Return (frames, torn) where frames is a list of [start, end) byte
    ranges of complete frames and torn is whether trailing bytes form an
    incomplete final frame. Mirrors the harness's structural scanner so the
    frame boundaries we edit are exactly the ones it validates."""
    frames = []
    offset = 0
    n = len(data)
    while offset < n:
        start = offset
        if n - offset < 4:
            return frames, True
        if int.from_bytes(data[offset:offset + 4], 'little') != ZSTD_MAGIC:
            raise ValueError(f'corrupt session log: invalid frame magic at byte {offset}')
        offset += 4
        if offset == n:
            return frames, True
        descriptor = data[offset]
        offset += 1
        if descriptor & 24:
            raise ValueError(f'corrupt session log: reserved frame-header bit at byte {offset - 1}')
        content_size_flag = descriptor >> 6
        single_segment = bool(descriptor & 32)
        checksum = bool(descriptor & 4)
        dictionary_flag = descriptor & 3
        dictionary_bytes = 4 if dictionary_flag == 3 else dictionary_flag
        content_size_bytes = (1 if single_segment else 0) if content_size_flag == 0 else 1 << content_size_flag
        remaining_header = (0 if single_segment else 1) + dictionary_bytes + content_size_bytes
        if n - offset < remaining_header:
            return frames, True
        offset += remaining_header
        while True:
            if n - offset < 3:
                return frames, True
            block_header = int.from_bytes(data[offset:offset + 3], 'little')
            offset += 3
            last_block = block_header & 1
            block_type = (block_header >> 1) & 3
            block_size = block_header >> 3
            if block_type == 3:
                raise ValueError(f'corrupt session log: reserved block type at byte {offset - 3}')
            payload_bytes = 1 if block_type == 1 else block_size
            if n - offset < payload_bytes:
                return frames, True
            offset += payload_bytes
            if last_block:
                break
        if checksum:
            if n - offset < 4:
                return frames, True
            offset += 4
        frames.append((start, offset))
    return frames, False


def needs_fix(record):
    """True for a swarm/progress event that lacks the ignorable marker."""
    if record.get('type') != TARGET_TYPE:
        return False
    return record.get('ignorable') is not True


def fix_log_lines(plaintext):
    """Return (fixed lines, changed count) for one frame's plaintext.

    Untouched records pass through byte-identical; only the events that gain
    the ignorable marker are re-serialized (compactly, with their original
    line terminator)."""
    changed = 0
    out = []
    for line in plaintext.splitlines(keepends=True):
        if not line.strip():
            out.append(line)
            continue
        record = json.loads(line)
        if not needs_fix(record):
            out.append(line)
            continue
        record['ignorable'] = True
        changed += 1
        terminator = b'\n' if line.endswith(b'\n') else b''
        out.append(json.dumps(record, ensure_ascii=False, separators=(',', ':')).encode('utf-8') + terminator)
    return out, changed


def fix_log(data):
    """Return (fixed bytes, changed count) preserving every frame boundary.

    Frame 0 is the header and is only validated (exactly one line), never
    rewritten; torn trailing bytes are kept as-is."""
    frames, torn = scan_zstd_frames(data)
    if not frames:
        raise ValueError('no complete zstd frames found')
    out = []
    changed = 0
    for index, (start, end) in enumerate(frames):
        frame = data[start:end]
        if index == 0:
            lines = decompress(frame).splitlines(keepends=True)
            if len(lines) != 1:
                raise ValueError('header frame is not exactly one line')
            out.append(frame)
            continue
        plaintext = decompress(frame)
        fixed, frame_changed = fix_log_lines(plaintext)
        out.append(compress(b''.join(fixed)) if frame_changed else frame)
        changed += frame_changed
    if torn:
        out.append(data[frames[-1][1]:])
    return b''.join(out), changed


def find_target_files(root):
    targets = []
    for dirpath, dirnames, filenames in os.walk(root):
        if LOG_NAME in filenames:
            targets.append(os.path.join(dirpath, LOG_NAME))
    return sorted(targets)


def main():
    dry_run = '--dry-run' in sys.argv
    positional = [a for a in sys.argv[1:] if a != '--dry-run']
    root = positional[0] if positional else SESSIONS_ROOT
    files = find_target_files(root)

    affected = []
    for path in files:
        try:
            raw = decompress(open(path, 'rb').read())
        except (subprocess.CalledProcessError, OSError):
            continue
        if any(needs_fix(json.loads(line)) for line in raw.decode('utf-8').splitlines() if line.strip()):
            affected.append(path)

    if not affected:
        print('没有需要修复的会话日志')
        return

    print(f'发现 {len(affected)} 个包含未标记 swarm/progress 的会话日志:')
    for path in affected:
        print(f'  {path}')
    if dry_run:
        print('（dry-run，未做任何修改）')
        return

    backup_dir = tempfile.mkdtemp(prefix='dsh-sessions-backup-')
    total_changed = 0
    for path in affected:
        fixed, changed = fix_log(open(path, 'rb').read())
        if changed == 0:
            continue
        # Back up the original artifact (same name, flat, under /tmp).
        rel = os.path.relpath(path, root).replace(os.sep, '__')
        shutil.copy2(path, os.path.join(backup_dir, rel))
        # Rewrite the log with the fixed events. The temp file lives next to
        # the target so os.replace stays on one filesystem.
        with tempfile.NamedTemporaryFile(dir=os.path.dirname(path), suffix='.zstd', delete=False) as tmp:
            tmp.write(fixed)
            tmp_path = tmp.name
        os.chmod(tmp_path, os.stat(path).st_mode)
        os.replace(tmp_path, path)
        total_changed += changed
        print(f'  修复 {path}: {changed} 个事件已标记 ignorable')

    print(f'完成: 共标记 {total_changed} 个事件, 原始文件备份在 {backup_dir}')
    print('备份目录请保留到确认会话可正常加载后再清理。')


if __name__ == '__main__':
    main()
