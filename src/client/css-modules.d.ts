/** CSS Modules type shim for the swarm client bundle. */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
