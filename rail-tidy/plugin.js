/**
 * Rail tidy: the profile row at the bottom of the sidebar shows only the Mac (This device)
 * and the VPS (default). Bot profiles stay reachable in the Bots tab and Manage profiles.
 * Lives on the Mac, so it holds whichever profile or backend is active.
 */
const CSS = `
[data-tour="profile-rail"] button[aria-label^="csm"],
[data-tour="profile-rail"] button[aria-label="New profile"],
[data-tour="profile-rail"] button[aria-label="Import profile…"],
[data-tour="profile-rail"] button[aria-label="All profiles on this gateway"] { display: none !important; }
`

export default {
  id: 'rail-tidy',
  name: 'Rail tidy',
  register(ctx) {
    const style = document.createElement('style')
    style.id = 'rail-tidy'
    style.textContent = CSS
    document.getElementById('rail-tidy')?.remove()
    document.head.appendChild(style)
    ctx.onDispose?.(() => style.remove())
  }
}
