import { resolveSlideLayout } from './slide-hit-test.js'

// Cover/ending text fitting now uses the shared unit hit-test (slide-hit-test.js):
// text is fitted to its box, whole units are moved/cropped away from each
// other and from decoration, clamped into the layout safe area, and boxes are
// tightened to their ink so title and body never overlap. On covers/endings
// decorative art that is not a full backdrop counts as a picture: text must
// not run over it (strictImages).
export function fitTerminalTextBoxes(report, slide, { titleIds = [] } = {}) {
  return resolveSlideLayout(report, slide, { titleIds, tightenText: true, strictImages: true }).slide
}
