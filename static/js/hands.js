// The two hands as ten fingertips, each a dot colored by its finger's health
// score (fingers.py): 0, healthy, a quiet gray-green; 1 to 10 blue through
// violet to red. Seen as you see your own hands on a table: the left hand on
// the left, thumbs low and pointing in, the middle fingers highest. Small on
// the calendar and in the Logbook, where pointing at a tip says its score;
// large in the form, where each tip is a button with its score on it.
// Nothing moves.

import { h, svg } from './ui.js';

// In the order of a check's scores (fingers.py FINGERS).
export const FINGER_NAMES = [
  'Left thumb', 'Left index', 'Left middle', 'Left ring', 'Left pinky',
  'Right thumb', 'Right index', 'Right middle', 'Right ring', 'Right pinky',
];

// 0 to 10. A healthy finger stays quiet, so only pain draws the eye; 1 to 10
// are evenly stepped in OKLCH (lightness 0.69 → 0.62, chroma 0.14 → 0.21),
// each at least 3.7:1 against the panel's surfaces.
export const FINGER_COLORS = [
  '#4b6358', '#6e99f1', '#838ef2', '#9883ee', '#ab77e4', '#bd6bd4',
  '#cc60bf', '#d854a5', '#e24a87', '#e84264', '#ea3d38',
];

export const fingerColor = (score) => FINGER_COLORS[Math.min(10, Math.max(0, score))];

export const HEALTHY = () => Array(10).fill(0);

// "Left middle 6", the sorest finger (the first of equals), or "No pain".
export function worstFinger(scores) {
  const top = Math.max(...scores);
  return top > 0 ? `${FINGER_NAMES[scores.indexOf(top)]} ${top}` : 'No pain';
}

// The fingers left to right as drawn (pinky to thumb, then thumb to pinky),
// by their index in a check's scores.
export const FINGERS_ACROSS = [4, 3, 2, 1, 0, 5, 6, 7, 8, 9];

// One tip for the page, saying which finger the mouse is on and its score.
let tip = null;
function showTip(dot, index, score) {
  if (!tip) {
    tip = document.body.appendChild(h('div', { class: 'finger-tip', role: 'tooltip', hidden: true }));
    addEventListener('scroll', hideTip, { capture: true, passive: true });
    addEventListener('hashchange', hideTip);
  }
  tip.replaceChildren(FINGER_NAMES[index], ' ', h('strong', {}, score));
  tip.hidden = false;
  const box = dot.getBoundingClientRect();
  const left = box.left + box.width / 2 - tip.offsetWidth / 2;
  tip.style.left = `${Math.max(4, Math.min(innerWidth - tip.offsetWidth - 4, left))}px`;
  tip.style.top = `${box.top - tip.offsetHeight - 6 < 4 ? box.bottom + 6 : box.top - tip.offsetHeight - 6}px`;
}
function hideTip() {
  if (tip) tip.hidden = true;
}

// Where each fingertip of the left hand sits, thumb to pinky (as the scores
// run), in finger widths across and down from the middle finger's tip. The
// right hand mirrors it.
const TIPS = [[4.25, 1.75], [3, 0.3], [2, 0], [1, 0.35], [0, 1.15]];
const U = 10;      // a finger's width, in viewBox units
const PAD = 7.5;   // room for the ring round a chosen tip
const GAP = 14;    // between the thumbs
const VIEW_W = 2 * PAD + 2 * TIPS[0][0] * U + GAP;
const VIEW_H = 2 * PAD + TIPS[0][1] * U;

// `width` in CSS pixels. With `onPick`, each tip is a button (Enter or Space
// picks it too) and `selected` (a finger's index) is ringed. `numbers` writes
// each finger's score in its tip. Otherwise pointing at a tip with a mouse
// outlines it and says its finger and score in a tip of its own; `hover` false
// leaves that out, and a function is told the finger's index (null on
// leaving) instead. A `label` of '' leaves screen readers to the text beside
// it (as an icon in a button).
export function drawHands(scores, { width = 56, selected = null, onPick = null, numbers = false, hover = !onPick, label = null } = {}) {
  // Small tips are a little bigger for their size, so they still read on a calendar day.
  const r = width < 64 ? 5 : 4.4;
  const root = svg('svg', {
    class: `hands${onPick ? ' interactive' : hover ? ' hoverable' : ''}`, viewBox: `0 0 ${VIEW_W} ${VIEW_H}`,
    width, height: Math.round((width * VIEW_H) / VIEW_W),
    role: onPick ? 'group' : label === '' ? null : 'img',
    'aria-label': label === '' ? null : label || (onPick ? 'Fingers' : `Fingers: ${worstFinger(scores)}`),
    'aria-hidden': label === '' ? 'true' : null,
  });
  scores.forEach((score, index) => {
    const right = index >= 5;
    const [across, down] = TIPS[index % 5];
    const x = right ? VIEW_W - PAD - across * U : PAD + across * U;
    const y = PAD + down * U;
    const finger = svg('g', { class: `hand-finger${index === selected ? ' selected' : ''}` },
      onPick && svg('circle', { class: 'hand-ring', cx: x, cy: y, r: r + 2.4 }),
      svg('circle', { class: 'hand-tip', cx: x, cy: y, r, fill: fingerColor(score) }),
      numbers && svg('text', { class: `hand-score${score > 0 ? '' : ' healthy'}`, x, y, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, score));
    if (onPick) {
      finger.setAttribute('tabindex', '0');
      finger.setAttribute('role', 'button');
      finger.setAttribute('aria-label', `${FINGER_NAMES[index]}, ${score}`);
      finger.setAttribute('aria-pressed', String(index === selected));
      finger.addEventListener('click', () => onPick(index));
      finger.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        onPick(index);
      });
    } else if (hover) {
      finger.addEventListener('pointerenter', (e) => {
        if (e.pointerType !== 'mouse') return;
        if (typeof hover === 'function') hover(index);
        else showTip(finger, index, score);
      });
      finger.addEventListener('pointerleave', () => (typeof hover === 'function' ? hover(null) : hideTip()));
    }
    root.append(finger);
  });
  return root;
}
