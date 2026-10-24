// Minimal keyed DOM morph. Patches `root` so its children match `html` while reusing every node that
// is still there: running animations, focus, scroll and typed input values survive a re-render.
// Children with a `data-key` attribute are matched by key; the rest by tag, in order.
const tpl = document.createElement('template');
const keyOf = (n) => (n.nodeType === 1 ? n.getAttribute('data-key') : null);

export function morph(root, html) {
  tpl.innerHTML = html;
  morphChildren(root, tpl.content);
}

function morphChildren(parent, next) {
  const keyed = new Map();
  for (let c = parent.firstChild; c; c = c.nextSibling) {
    const k = keyOf(c);
    if (k) keyed.set(k, c);
  }
  const used = new Set();
  let cursor = parent.firstChild;
  for (const nk of Array.from(next.childNodes)) {
    const key = keyOf(nk);
    let match = null;
    if (key) {
      const c = keyed.get(key);
      if (c && c.nodeName === nk.nodeName && !used.has(c)) match = c;
    } else {
      for (let c = cursor; c; c = c.nextSibling) {
        if (!used.has(c) && !keyOf(c) && c.nodeType === nk.nodeType && c.nodeName === nk.nodeName) { match = c; break; }
      }
    }
    if (match) {
      used.add(match);
      patch(match, nk);
      if (match === cursor) cursor = cursor.nextSibling;
      else parent.insertBefore(match, cursor);
    } else {
      used.add(nk);
      parent.insertBefore(nk, cursor);
    }
  }
  for (let c = parent.firstChild; c;) {
    const n = c.nextSibling;
    if (!used.has(c)) parent.removeChild(c);
    c = n;
  }
}

function patch(el, nk) {
  if (el.nodeType !== 1) {
    if (el.nodeValue !== nk.nodeValue) el.nodeValue = nk.nodeValue;
    return;
  }
  for (const { name } of Array.from(el.attributes)) {
    if (!nk.hasAttribute(name)) el.removeAttribute(name);
  }
  for (const { name, value } of Array.from(nk.attributes)) {
    if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  }
  morphChildren(el, nk);
}
