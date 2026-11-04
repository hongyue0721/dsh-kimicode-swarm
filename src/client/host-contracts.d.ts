/** rc.5 composer seat, read from dsh-client-ui-conversation's installed host source.
 * The provided SDK set does not include that package's declaration merge.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'conversation.input.left': { kind: 'list'; scope: 'session' }
  }
}
