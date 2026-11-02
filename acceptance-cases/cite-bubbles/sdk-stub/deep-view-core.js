// Stand-in so the cite runtime test can load the group host without the deep-view package.
// main's CI runs the suite on the standard library alone, and groups.js reaches this
// module through tools.js.
export function checkShownView() {
  return undefined
}

export function showViewDescription() {
  return ''
}

export function showViewParameters() {
  return {}
}
