/* eslint-disable */
/* Page-side half of Pigry's Cypress-style E2E runner. It is injected into the
 * external test browser (as an init script, so it is active before the app's
 * own scripts) and exposes window.__cy. The runner (src/extensions/e2e/engine/runner.ts)
 * calls it through eval: every call returns a JSON string
 *   { r: <result>, e: [uncaught errors since the last call], n: <document id> }
 * Everything here is plain ES2017 — no imports, nothing from the app. */
(function () {
  'use strict';
  if (window.__cy && window.__cy.v === 7) return;
  var cy = window.__cy = { v: 7, nav: Math.random().toString(36).slice(2), routes: [], calls: [], errors: [], dialogs: [], opts: { confirm: true, promptValue: null }, seq: 0, spies: {}, spySeq: 0, clock: null, rec: [], recOn: false, picking: false };
  var slice = Array.prototype.slice;

  /* ---------------- small helpers ---------------- */
  function arr(x) { return slice.call(x); }
  function uniq(list) { var out = []; list.forEach(function (el) { if (el && out.indexOf(el) < 0) out.push(el); }); return out; }
  function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function esc(s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&'); }
  function describe(el) {
    if (!el || el.nodeType !== 1) return String(el);
    var d = '<' + el.tagName.toLowerCase();
    if (el.id) d += '#' + el.id;
    var c = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3) : [];
    if (c.length) d += '.' + c.join('.');
    return d + '>';
  }
  function setNative(el, value) {
    var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
  }
  function fire(el, type, init, Ctor) {
    var C = Ctor || Event;
    var ev;
    try { ev = new C(type, Object.assign({ bubbles: true, cancelable: true, composed: true }, init || {})); } catch (e) { ev = new Event(type, { bubbles: true, cancelable: true }); }
    return el.dispatchEvent(ev);
  }

  /* ---------------- visibility / actionability ---------------- */
  function visible(el) {
    if (!el || !el.isConnected) return false;
    if (el.tagName === 'OPTION' || el.tagName === 'OPTGROUP') return el.parentElement ? visible(el.parentElement) : false;
    var s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.visibility === 'collapse') return false;
    var r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0) && !(el.offsetWidth > 0 || el.offsetHeight > 0)) {
      // zero-size elements with visible children (e.g. inline wrappers) still count
      var any = false;
      for (var i = 0; i < el.children.length; i += 1) { var cr = el.children[i].getBoundingClientRect(); if (cr.width > 0 && cr.height > 0) { any = true; break; } }
      if (!any) return false;
    }
    for (var p = el; p && p.nodeType === 1; p = p.parentElement) {
      var cs = getComputedStyle(p);
      if (cs.display === 'none') return false;
      if (p === el && cs.opacity === '0') return false;
      if (p !== el && cs.overflow !== 'visible' && cs.position !== 'fixed') {
        var pr = p.getBoundingClientRect();
        if (pr.width === 0 || pr.height === 0) return false;
        if (r.right <= pr.left || r.left >= pr.right || r.bottom <= pr.top || r.top >= pr.bottom) { if (cs.overflow !== 'auto' && cs.overflow !== 'scroll') return false; }
      }
    }
    return true;
  }
  function disabled(el) { return !!(el.disabled || (el.closest && el.closest('fieldset[disabled]') && el.tagName !== 'LEGEND')); }
  function focusable(el) { return el.matches && el.matches('input,select,textarea,button,a[href],[tabindex],[contenteditable=""],[contenteditable="true"],summary,area[href]') && !disabled(el); }

  /* ---------------- query engine ---------------- */
  function pseudoFilter(els, name, arg) {
    if (name === 'visible') return els.filter(visible);
    if (name === 'hidden') return els.filter(function (e) { return !visible(e); });
    if (name === 'first') return els.slice(0, 1);
    if (name === 'last') return els.slice(-1);
    if (name === 'eq') { var n = parseInt(arg, 10); if (n < 0) n = els.length + n; return els[n] ? [els[n]] : []; }
    if (name === 'even') return els.filter(function (e, i) { return i % 2 === 0; });
    if (name === 'odd') return els.filter(function (e, i) { return i % 2 === 1; });
    if (name === 'contains') { var t = String(arg).replace(/^(["'])(.*)\1$/, '$2'); return els.filter(function (e) { return (e.textContent || '').indexOf(t) >= 0; }); }
    return els;
  }
  var PSEUDO = /:(contains|visible|hidden|first|last|eq|even|odd)(?![\w-])(?:\(((?:[^()]|\([^()]*\))*)\))?/;
  /** root plus every open shadow root below it (includeShadowDom) */
  function deepRoots(root) {
    var out = [root], queue = [root];
    while (queue.length) {
      var r = queue.shift();
      arr(r.querySelectorAll ? r.querySelectorAll('*') : []).forEach(function (e) { if (e.shadowRoot) { out.push(e.shadowRoot); queue.push(e.shadowRoot); } });
    }
    return out;
  }
  var DEEP = false;
  function qsa(root, sel) {
    var m = PSEUDO.exec(sel);
    if (!m) {
      try {
        if (!DEEP) return arr(root.querySelectorAll(sel));
        var found = []; deepRoots(root).forEach(function (r) { found = found.concat(arr(r.querySelectorAll(sel))); }); return uniq(found);
      } catch (e) { throw new Error('Invalid selector "' + sel + '": ' + e.message); }
    }
    var base = sel.slice(0, m.index).trim() || '*';
    var rest = sel.slice(m.index + m[0].length).trim();
    var els = pseudoFilter(qsa(root, base), m[1], m[2]);
    if (!rest) return els;
    var out = [];
    els.forEach(function (e) {
      if (rest.charAt(0) === '>' || rest.charAt(0) === '+' || rest.charAt(0) === '~') out = out.concat(arr(e.querySelectorAll(':scope ' + rest)));
      else out = out.concat(qsa(e, rest));
    });
    return uniq(out);
  }
  function roots(scope) { var rs = [document]; (scope || []).forEach(function (layer) { rs = resolveFrom(layer, rs); }); return rs; }
  function textOf(el) { return norm(el.textContent); }
  function containsStep(rs, step) {
    var needle = step.text, re = step.re ? new RegExp(step.re, step.flags || '') : null, matchCase = step.matchCase !== false;
    var hay = function (s) { s = norm(s); if (re) return re.test(s); return matchCase ? s.indexOf(norm(needle)) >= 0 : s.toLowerCase().indexOf(norm(needle).toLowerCase()) >= 0; };
    var all = [];
    rs.forEach(function (r) {
      var cands = step.s ? qsa(r, step.s) : (DEEP ? deepRoots(r).reduce(function (a, x) { return a.concat(arr(x.querySelectorAll('*'))); }, []) : arr(r.querySelectorAll('*')));
      if (r.nodeType === 1 && (!step.s || (r.matches && r.matches(step.s)))) cands.unshift(r);
      all = all.concat(cands);
    });
    all = uniq(all).filter(function (e) { return !/^(SCRIPT|STYLE|NOSCRIPT|HEAD|TITLE|META|LINK)$/.test(e.tagName); });
    var withText = all.filter(function (e) { return hay(e.textContent || '') || ((e.tagName === 'INPUT') && /^(submit|button|reset)$/.test(e.type) && hay(e.value)); });
    var deepest = withText.filter(function (e) { return !arr(e.children).some(function (c) { return withText.indexOf(c) >= 0 && c.tagName !== 'SCRIPT'; }); });
    if (!deepest.length) return [];
    var prefer = 'input[type="submit"], button, a, label';
    for (var i = 0; i < deepest.length; i += 1) { var up = deepest[i].closest(prefer); if (up && withText.indexOf(up) >= 0) { deepest[i] = up; break; } }
    return uniq(deepest).slice(0, 1);
  }
  function resolve(steps, scope) { return resolveFrom(steps, scope && scope.length ? roots(scope) : null); }
  function resolveFrom(steps, rs) {
    var cur = null;
    (steps || []).forEach(function (st, idx) {
      var t = st.t;
      DEEP = !!st.deep || DEEP;
      if (t === 'get') { var bases = rs || [document]; var out = []; bases.forEach(function (b) { out = out.concat(qsa(b, st.s)); }); cur = uniq(out); }
      else if (t === 'contains') { var b2 = cur && idx > 0 ? cur : (rs || [document]); cur = containsStep(b2, st); }
      else if (t === 'root') cur = [document.documentElement];
      else if (t === 'focused') cur = document.activeElement && document.activeElement !== document.body ? [document.activeElement] : [];
      else if (t === 'find') { var o2 = []; (cur || []).forEach(function (e) { o2 = o2.concat(qsa(e, st.s)); }); cur = uniq(o2); }
      else if (t === 'filter') cur = (cur || []).filter(function (e) { return st.s ? e.matches(st.s) : true; });
      else if (t === 'not') cur = (cur || []).filter(function (e) { return !e.matches(st.s); });
      else if (t === 'first') cur = (cur || []).slice(0, 1);
      else if (t === 'last') cur = (cur || []).slice(-1);
      else if (t === 'eq') { var n = st.n < 0 ? (cur || []).length + st.n : st.n; cur = cur && cur[n] ? [cur[n]] : []; }
      else if (t === 'children') { var o3 = []; (cur || []).forEach(function (e) { o3 = o3.concat(arr(e.children)); }); cur = uniq(o3).filter(function (e) { return st.s ? e.matches(st.s) : true; }); }
      else if (t === 'parent') cur = uniq((cur || []).map(function (e) { return e.parentElement; })).filter(function (e) { return e && (st.s ? e.matches(st.s) : true); });
      else if (t === 'parents') { var o4 = []; (cur || []).forEach(function (e) { for (var p = e.parentElement; p; p = p.parentElement) if (!st.s || p.matches(st.s)) o4.push(p); }); cur = uniq(o4); }
      else if (t === 'closest') cur = uniq((cur || []).map(function (e) { return e.closest(st.s); }));
      else if (t === 'siblings') { var o5 = []; (cur || []).forEach(function (e) { arr(e.parentElement ? e.parentElement.children : []).forEach(function (c) { if (c !== e && (!st.s || c.matches(st.s))) o5.push(c); }); }); cur = uniq(o5); }
      else if (t === 'next') cur = uniq((cur || []).map(function (e) { return e.nextElementSibling; })).filter(function (e) { return e && (!st.s || e.matches(st.s)); });
      else if (t === 'prev') cur = uniq((cur || []).map(function (e) { return e.previousElementSibling; })).filter(function (e) { return e && (!st.s || e.matches(st.s)); });
      else if (t === 'nextAll') { var o6 = []; (cur || []).forEach(function (e) { for (var p = e.nextElementSibling; p; p = p.nextElementSibling) if (!st.s || p.matches(st.s)) o6.push(p); }); cur = uniq(o6); }
      else if (t === 'prevAll') { var o7 = []; (cur || []).forEach(function (e) { for (var p = e.previousElementSibling; p; p = p.previousElementSibling) if (!st.s || p.matches(st.s)) o7.push(p); }); cur = uniq(o7); }
      else if (t === 'iframe') { cur = uniq((cur || []).map(function (e) { try { return e.contentDocument && e.contentDocument.body; } catch (x) { return null; } })).filter(Boolean); }
      else if (t === 'parentsUntil') { var o8 = []; (cur || []).forEach(function (e) { for (var p = e.parentElement; p && !(st.s && p.matches(st.s)); p = p.parentElement) o8.push(p); }); cur = uniq(o8); }
      else if (t === 'nextUntil') { var o9 = []; (cur || []).forEach(function (e) { for (var p = e.nextElementSibling; p && !(st.s && p.matches(st.s)); p = p.nextElementSibling) o9.push(p); }); cur = uniq(o9); }
      else if (t === 'prevUntil') { var o10 = []; (cur || []).forEach(function (e) { for (var p = e.previousElementSibling; p && !(st.s && p.matches(st.s)); p = p.previousElementSibling) o10.push(p); }); cur = uniq(o10); }
      else if (t === 'shadow') { cur = uniq((cur || []).map(function (e) { return e.shadowRoot; })).filter(Boolean).map(function (r) { return r; }); }
    });
    DEEP = false;
    return cur || [];
  }

  function attrsOf(el) { var o = {}; arr(el.attributes || []).forEach(function (a) { o[a.name] = a.value; }); return o; }
  function snapEl(el, cssProps) {
    var r = el.getBoundingClientRect ? el.getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0 };
    var css = {};
    if (cssProps && cssProps.length && el.nodeType === 1) { var cs = getComputedStyle(el); cssProps.forEach(function (p) { css[p] = cs.getPropertyValue(p); }); }
    var isEl = el.nodeType === 1;
    return {
      tag: isEl ? el.tagName.toLowerCase() : (el.host ? '#shadow-root' : '#document'), id: el.id || '', cls: isEl && typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean) : [],
      text: (el.textContent || '').slice(0, 4000), html: isEl ? el.innerHTML.slice(0, 4000) : '',
      value: el.value !== undefined && typeof el.value === 'string' ? el.value : (el.value != null ? String(el.value) : undefined),
      vis: isEl ? visible(el) : true, dis: isEl ? disabled(el) : false, chk: !!el.checked, sel: !!el.selected, foc: (el.ownerDocument || document).activeElement === el,
      attrs: isEl ? attrsOf(el) : {}, css: css, empty: isEl ? (el.children.length === 0 && !(el.textContent || '').trim()) : false,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, desc: describe(el),
      readOnly: !!el.readOnly, required: !!el.required, type: el.type || '', name: el.name || '',
    };
  }
  function snap(steps, scope, opts) {
    var els = resolve(steps, scope);
    return { count: els.length, els: els.slice(0, 200).map(function (e) { return snapEl(e, opts && opts.css); }) };
  }

  /* ---------------- actions ---------------- */
  function center(el, o) {
    var r = el.getBoundingClientRect();
    var x = r.left + r.width / 2, y = r.top + r.height / 2;
    var pos = o && o.position;
    if (pos === 'topLeft') { x = r.left + 1; y = r.top + 1; }
    else if (pos === 'top') y = r.top + 1;
    else if (pos === 'topRight') { x = r.right - 1; y = r.top + 1; }
    else if (pos === 'left') x = r.left + 1;
    else if (pos === 'right') x = r.right - 1;
    else if (pos === 'bottomLeft') { x = r.left + 1; y = r.bottom - 1; }
    else if (pos === 'bottom') y = r.bottom - 1;
    else if (pos === 'bottomRight') { x = r.right - 1; y = r.bottom - 1; }
    if (o && o.x != null) x = r.left + o.x;
    if (o && o.y != null) y = r.top + o.y;
    return { x: x, y: y };
  }
  /** the topmost element at a point, looking inside the element's own shadow root / document */
  function hit(el, pt) {
    var root = el.getRootNode ? el.getRootNode() : document;
    return (root && root.elementFromPoint ? root : (el.ownerDocument || document)).elementFromPoint(pt.x, pt.y);
  }
  function composedContains(a, b) {
    for (var n = b; n; n = n.parentNode || n.host) { if (n === a) return true; }
    return false;
  }
  function actionable(el, o, verb) {
    if (o.force) return null;
    if (!visible(el)) return 'cy.' + verb + '() failed because this element is not visible: ' + describe(el);
    if (disabled(el) && verb !== 'scrollIntoView' && verb !== 'trigger' && verb !== 'focus' && verb !== 'blur' && verb !== 'submit') return 'cy.' + verb + '() failed because this element is disabled: ' + describe(el);
    if (verb === 'type' && (el.readOnly)) return 'cy.type() failed because this element is readonly: ' + describe(el);
    if (verb === 'scrollIntoView' || verb === 'focus' || verb === 'blur' || verb === 'submit') return null;
    el.scrollIntoView({ block: o.scrollBehavior || 'center', inline: 'nearest' });
    var pt = center(el, o);
    var top = hit(el, pt);
    if (top && top !== el && !composedContains(el, top) && !composedContains(top, el) && !(el.tagName === 'OPTION')) {
      return 'cy.' + verb + '() failed because this element is being covered by another element: ' + describe(top);
    }
    return null;
  }
  function mods(o) { return { ctrlKey: !!o.ctrlKey, shiftKey: !!o.shiftKey, altKey: !!o.altKey, metaKey: !!o.metaKey }; }
  function blurOthers(el) {
    var ae = document.activeElement;
    if (ae && ae !== el && ae !== document.body && ae.blur) ae.blur();
  }
  function mouse(el, o, kind) {
    var pt = center(el, o);
    var target = hit(el, pt) || el;
    if (o.force || !(target === el || composedContains(el, target) || composedContains(target, el))) target = el;
    var base = Object.assign({ view: window, clientX: pt.x, clientY: pt.y, screenX: pt.x, screenY: pt.y, button: kind === 'right' ? 2 : 0, buttons: kind === 'right' ? 2 : 1 }, mods(o));
    var up = Object.assign({}, base, { buttons: 0 });
    var PE = window.PointerEvent || MouseEvent;
    fire(target, 'pointerover', base, PE); fire(target, 'mouseover', base, MouseEvent);
    fire(target, 'pointermove', base, PE); fire(target, 'mousemove', base, MouseEvent);
    var pd = fire(target, 'pointerdown', base, PE);
    var md = fire(target, 'mousedown', base, MouseEvent);
    if (md !== false) {
      var foc = target.closest ? target.closest('input,select,textarea,button,a[href],[tabindex],[contenteditable="true"],[contenteditable=""],summary,label') : null;
      var ft = foc && foc.tagName === 'LABEL' ? (foc.control || null) : foc;
      blurOthers(ft || document.body);
      if (ft && focusable(ft)) ft.focus();
    }
    fire(target, 'pointerup', up, PE); fire(target, 'mouseup', up, MouseEvent);
    if (kind === 'right') { fire(target, 'contextmenu', up, MouseEvent); return; }
    fire(target, 'click', Object.assign({}, up, { detail: 1 }), MouseEvent);
    if (kind === 'double') {
      fire(target, 'pointerdown', base, PE); fire(target, 'mousedown', base, MouseEvent); fire(target, 'pointerup', up, PE); fire(target, 'mouseup', up, MouseEvent);
      fire(target, 'click', Object.assign({}, up, { detail: 2 }), MouseEvent); fire(target, 'dblclick', Object.assign({}, up, { detail: 2 }), MouseEvent);
    }
  }

  var KEYS = { enter: ['Enter', 13], esc: ['Escape', 27], backspace: ['Backspace', 8], del: ['Delete', 46], leftarrow: ['ArrowLeft', 37], rightarrow: ['ArrowRight', 39], uparrow: ['ArrowUp', 38], downarrow: ['ArrowDown', 40], home: ['Home', 36], end: ['End', 35], pageup: ['PageUp', 33], pagedown: ['PageDown', 34], insert: ['Insert', 45], tab: ['Tab', 9] };
  function textLike(el) { return el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|search|url|tel|password|email|number|)$/i.test(el.type || '')); }
  function selSupported(el) { try { return el.selectionStart !== null && el.selectionStart !== undefined; } catch (e) { return false; } }
  function key(el, type, k, code, m) { return fire(el, type, Object.assign({ key: k, code: code, keyCode: code && code.length === 1 ? 0 : 0, which: 0, view: window }, m), KeyboardEvent); }
  function typeText(el, text, o) {
    var m = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };
    if (document.activeElement !== el) { mouse(el, Object.assign({ force: true }, o), 'left'); if (document.activeElement !== el && el.focus) el.focus(); }
    el.__cyInit = el.__cyDirty ? el.__cyInit : (el.value !== undefined ? el.value : null);
    var wholeValue = el.tagName === 'INPUT' && /^(date|datetime-local|month|week|time|color|range)$/i.test(el.type);
    if (wholeValue) {
      setNative(el, text); fire(el, 'input', {}, Event); el.__cyDirty = true; return;
    }
    var tokens = o.parse === false ? text.split('') : (text.match(/\{[^}]*\}|[\s\S]/g) || []);
    var specialSeen = [];
    tokens.forEach(function (tk) {
      var name = tk.length > 1 && tk.charAt(0) === '{' && tk.charAt(tk.length - 1) === '}' ? tk.slice(1, -1).toLowerCase() : null;
      if (tk === '{{}') { name = null; tk = '{'; }
      if (name === 'ctrl' || name === 'control') { m.ctrlKey = true; return; }
      if (name === 'shift') { m.shiftKey = true; return; }
      if (name === 'alt' || name === 'option') { m.altKey = true; return; }
      if (name === 'meta' || name === 'command' || name === 'cmd') { m.metaKey = true; return; }
      var ce = el.isContentEditable;
      if (name === 'selectall') { if (selSupported(el)) el.select(); else document.execCommand('selectAll'); return; }
      if (name === 'movetostart') { if (selSupported(el)) el.setSelectionRange(0, 0); return; }
      if (name === 'movetoend') { if (selSupported(el)) el.setSelectionRange(el.value.length, el.value.length); return; }
      if (name && KEYS[name]) {
        var kk = KEYS[name];
        var cancelled = key(el, 'keydown', kk[0], kk[0], m) === false;
        if (!cancelled) {
          if (name === 'enter') {
            key(el, 'keypress', 'Enter', 'Enter', m);
            if (el.tagName === 'TEXTAREA') { insert(el, '\n', m); }
            else if (el.tagName === 'INPUT' && el.form) { var f = el.form; var btn = f.querySelector('button[type="submit"],button:not([type]),input[type="submit"]'); if (btn && !disabled(btn)) mouse(btn, { force: true }, 'left'); else if (f.querySelectorAll('input').length === 1 || !btn) { var sev = new Event('submit', { bubbles: true, cancelable: true }); if (f.dispatchEvent(sev)) f.submit(); } }
            else if (ce) document.execCommand('insertParagraph');
          } else if (name === 'backspace' || name === 'del') {
            if (selSupported(el)) {
              var s = el.selectionStart, e2 = el.selectionEnd, v = el.value;
              if (s === e2) { if (name === 'backspace') s = Math.max(0, s - 1); else e2 = Math.min(v.length, e2 + 1); }
              if (s !== e2 || v.length) { setNative(el, v.slice(0, s) + v.slice(e2)); el.setSelectionRange(s, s); fire(el, 'input', { inputType: name === 'backspace' ? 'deleteContentBackward' : 'deleteContentForward' }, window.InputEvent || Event); el.__cyDirty = true; }
            } else if (ce) document.execCommand(name === 'backspace' ? 'delete' : 'forwardDelete');
          } else if (name === 'leftarrow' || name === 'rightarrow' || name === 'home' || name === 'end') {
            if (selSupported(el)) { var p = el.selectionStart; p = name === 'leftarrow' ? Math.max(0, p - 1) : name === 'rightarrow' ? Math.min(el.value.length, p + 1) : name === 'home' ? 0 : el.value.length; el.setSelectionRange(p, p); }
          }
        }
        key(el, 'keyup', kk[0], kk[0], m);
        return;
      }
      // a normal character
      var ch = tk;
      var code = /^[a-z]$/i.test(ch) ? 'Key' + ch.toUpperCase() : /^[0-9]$/.test(ch) ? 'Digit' + ch : ch === ' ' ? 'Space' : ch;
      if (key(el, 'keydown', ch, code, m) === false) { key(el, 'keyup', ch, code, m); return; }
      if (key(el, 'keypress', ch, code, m) !== false) insert(el, ch, m);
      key(el, 'keyup', ch, code, m);
    });
    function insert(t, ch) {
      if (t.isContentEditable) { document.execCommand('insertText', false, ch); t.__cyDirty = true; return; }
      if (!textLike(t) && t.tagName !== 'TEXTAREA') return;
      var before = fire(t, 'beforeinput', { data: ch, inputType: 'insertText' }, window.InputEvent || Event);
      if (before === false) return;
      var v = t.value, s = v.length, e = v.length;
      if (selSupported(t)) { s = t.selectionStart; e = t.selectionEnd; }
      var next = v.slice(0, s) + ch + v.slice(e);
      if (t.maxLength > 0 && next.length > t.maxLength) return;
      setNative(t, next);
      if (selSupported(t)) t.setSelectionRange(s + ch.length, s + ch.length);
      fire(t, 'input', { data: ch, inputType: 'insertText' }, window.InputEvent || Event);
      t.__cyDirty = true;
    }
  }
  document.addEventListener('focusout', function (ev) {
    var t = ev.target;
    if (t && t.__cyDirty) { t.__cyDirty = false; if (t.__cyInit !== t.value) fire(t, 'change', {}, Event); t.__cyInit = t.value; }
  }, true);

  function doAction(el, action, o, args) {
    if (action === 'click') mouse(el, o, 'left');
    else if (action === 'dblclick') mouse(el, o, 'double');
    else if (action === 'rightclick') mouse(el, o, 'right');
    else if (action === 'hover') { var hp = center(el, o), hb = Object.assign({ view: window, clientX: hp.x, clientY: hp.y }, mods(o)); var hPE = window.PointerEvent || MouseEvent; fire(el, 'pointerover', hb, hPE); fire(el, 'pointerenter', Object.assign({}, hb, { bubbles: false }), hPE); fire(el, 'mouseover', hb, MouseEvent); fire(el, 'mouseenter', Object.assign({}, hb, { bubbles: false }), MouseEvent); fire(el, 'pointermove', hb, hPE); fire(el, 'mousemove', hb, MouseEvent); }
    else if (action === 'type') typeText(el, String(args.text), o);
    else if (action === 'clear') { typeText(el, '{selectall}{backspace}', o); if (el.value) { setNative(el, ''); fire(el, 'input', {}, Event); } }
    else if (action === 'check' || action === 'uncheck') {
      if (!/^(checkbox|radio)$/i.test(el.type)) throw new Error('cy.' + action + '() can only be called on :checkbox and :radio. Your subject is: ' + describe(el));
      var want = action === 'check';
      if (args.values && args.values.length && args.values.indexOf(el.value) < 0) return;
      if (el.checked !== want) mouse(el, o, 'left');
    }
    else if (action === 'select') {
      if (el.tagName !== 'SELECT') throw new Error('cy.select() can only be called on a <select>. Your subject is a: ' + describe(el));
      var vals = args.values, found = 0;
      var opts = arr(el.options);
      var chosen = vals.map(function (v) {
        var op = opts.filter(function (x) { return x.value === String(v) || norm(x.text) === String(v); })[0];
        if (!op && typeof v === 'number') op = opts[v];
        if (!op) throw new Error('cy.select() failed because it could not find a single <option> with value, index, or text matching: ' + JSON.stringify(v));
        if (op.disabled) throw new Error('cy.select() failed because this <option> is disabled: ' + describe(op));
        return op;
      });
      if (!el.multiple && chosen.length > 1) throw new Error('cy.select() was called with an array of arguments but does not have a multiple attribute set.');
      mouse(el, Object.assign({ force: true }, o), 'left');
      opts.forEach(function (op) { op.selected = chosen.indexOf(op) >= 0; found += op.selected ? 1 : 0; });
      fire(el, 'input', {}, Event); fire(el, 'change', {}, Event);
    }
    else if (action === 'focus') { if (!focusable(el) && !el.hasAttribute('tabindex')) throw new Error('cy.focus() can only be called on a valid focusable element. Your subject is a: ' + describe(el)); el.focus(); }
    else if (action === 'blur') { if (document.activeElement !== el) throw new Error('cy.blur() can only be called on the focused element. Currently the focused element is: ' + describe(document.activeElement)); el.blur(); }
    else if (action === 'submit') {
      var form = el.tagName === 'FORM' ? el : el.closest('form');
      if (!form) throw new Error('cy.submit() can only be called on a <form>. Your subject is a: ' + describe(el));
      var sev = new Event('submit', { bubbles: true, cancelable: true }); if (form.dispatchEvent(sev)) form.submit();
    }
    else if (action === 'trigger') {
      var pt = center(el, o);
      var type = args.event, init = Object.assign({ clientX: pt.x, clientY: pt.y }, args.init || {});
      var Ctor = /^(mouse|click|dblclick|contextmenu|wheel)/.test(type) ? (type === 'wheel' ? WheelEvent : MouseEvent) : /^pointer/.test(type) ? (window.PointerEvent || MouseEvent) : /^key/.test(type) ? KeyboardEvent : /^(input|beforeinput)$/.test(type) ? (window.InputEvent || Event) : /^(focus|blur)$/.test(type) ? FocusEvent : /^drag|drop/.test(type) ? (window.DragEvent || MouseEvent) : Event;
      var ev;
      try { ev = new Ctor(type, Object.assign({ bubbles: true, cancelable: true, composed: true }, init)); } catch (e) { ev = new Event(type, { bubbles: true, cancelable: true }); }
      if (args.init) Object.keys(args.init).forEach(function (k) { try { if (ev[k] === undefined) ev[k] = args.init[k]; } catch (e) { /* read-only */ } });
      el.dispatchEvent(ev);
    }
    else if (action === 'scrollIntoView') el.scrollIntoView({ block: o.block || 'start', inline: 'nearest' });
    else if (action === 'scrollTo') { var tx = args.x, ty = args.y; var pos = args.pos; if (pos) { var mp = { top: [0, 0], center: [0.5, 0.5], bottom: [0, 1], left: [0, 0], right: [1, 0], topLeft: [0, 0], topRight: [1, 0], bottomLeft: [0, 1], bottomRight: [1, 1] }[pos] || [0, 0]; tx = (el.scrollWidth - el.clientWidth) * mp[0]; ty = (el.scrollHeight - el.clientHeight) * mp[1]; } el.scrollTo({ left: tx, top: ty }); }
    else if (action === 'selectFile') {
      var files = (args.files || []).map(function (f) { return new File([f.contents == null ? '' : f.contents], f.fileName || 'file.txt', { type: f.mimeType || 'text/plain', lastModified: f.lastModified || Date.now() }); });
      var dt = new DataTransfer(); files.forEach(function (f) { dt.items.add(f); });
      if (args.drag) { ['dragenter', 'dragover', 'drop'].forEach(function (n) { var ev2 = new Event(n, { bubbles: true, cancelable: true }); ev2.dataTransfer = dt; el.dispatchEvent(ev2); }); }
      else { el.files = dt.files; fire(el, 'input', {}, Event); fire(el, 'change', {}, Event); }
    }
    else throw new Error('unknown action ' + action);
  }

  /** offset of the element's document inside the top window (iframes) */
  function frameOffset(el) {
    var x = 0, y = 0, w = (el.ownerDocument || document).defaultView;
    try { while (w && w.frameElement) { var r = w.frameElement.getBoundingClientRect(); x += r.left; y += r.top; w = w.parent; } } catch (e) { /* cross-origin */ }
    return { x: x, y: y };
  }
  function rectOf(steps, scope) {
    var els = resolve(steps, scope); if (!els[0]) return null;
    var r = els[0].getBoundingClientRect(), o = frameOffset(els[0]);
    return { x: r.left + o.x, y: r.top + o.y, w: r.width, h: r.height, sx: window.scrollX, sy: window.scrollY };
  }
  function act(steps, scope, action, o, args) {
    o = o || {}; args = args || {};
    var els = resolve(steps, scope);
    if (!els.length) return { ok: false, retry: true, reason: 'Expected to find element: `' + describeSteps(steps) + '`, but never found it.' };
    var multi = !!o.multiple;
    if (els.length > 1 && !multi && /^(click|dblclick|rightclick|type|clear|focus|blur|submit|scrollIntoView|selectFile)$/.test(action)) {
      return { ok: false, fatal: true, reason: 'cy.' + action + '() can only be called on a single element. Your subject contained ' + els.length + ' elements. Pass { multiple: true } if you want to serially ' + action + ' each element.' };
    }
    var targets = multi ? els : [els[0]];
    for (var i = 0; i < targets.length; i += 1) {
      var why = actionable(targets[i], o, action);
      if (why) return { ok: false, retry: true, reason: why };
    }
    var shown = snapEl(targets[0]);
    if (o.dry) {
      var tgt = targets[0], dp = center(tgt, o), fo = frameOffset(tgt);
      return { ok: true, dry: true, target: shown, count: 1, point: { x: dp.x + fo.x, y: dp.y + fo.y }, focused: (tgt.ownerDocument || document).activeElement === tgt, checked: !!tgt.checked, value: tgt.value != null ? String(tgt.value) : '', type: tgt.type || '', tag: tgt.tagName.toLowerCase(), editable: !!tgt.isContentEditable, selStart: selSupported(tgt) ? tgt.selectionStart : null, valueLen: tgt.value != null ? String(tgt.value).length : 0, wholeValue: tgt.tagName === 'INPUT' && /^(date|datetime-local|month|week|time|color|range|file)$/i.test(tgt.type) };
    }
    for (var j = 0; j < targets.length; j += 1) {
      try { doAction(targets[j], action, o, args); } catch (e) { return { ok: false, fatal: true, reason: e.message }; }
    }
    return { ok: true, target: shown, count: targets.length };
  }
  function describeSteps(steps) {
    return (steps || []).map(function (s) { return s.t === 'get' ? s.s : s.t === 'contains' ? 'contains(' + (s.s ? s.s + ', ' : '') + (s.text != null ? s.text : '/' + s.re + '/') + ')' : s.t + (s.s ? '(' + s.s + ')' : s.n != null ? '(' + s.n + ')' : ''); }).join(' → ');
  }

  /* ---------------- highlight / snapshot helpers ---------------- */
  function selectAll() {
    var ae = document.activeElement;
    if (ae && selSupported(ae)) ae.select(); else document.execCommand('selectAll');
    return true;
  }
  function caret(where) {
    var ae = document.activeElement;
    if (ae && selSupported(ae)) { var p = where === 'start' ? 0 : ae.value.length; ae.setSelectionRange(p, p); }
    return true;
  }
  function pressKey(name) {
    var ae = document.activeElement || document.body;
    var k = KEYS[String(name).toLowerCase()] ? KEYS[String(name).toLowerCase()][0] : name;
    var down = key(ae, 'keydown', k, k, {});
    if (down !== false && k === 'Tab') {
      var f = arr(document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]')).filter(function (e) { return !disabled(e) && e.tabIndex >= 0 && visible(e); });
      var i = f.indexOf(ae); var nx = f[(i + 1) % f.length]; if (nx) nx.focus();
    } else if (down !== false && k === 'Enter' && ae && /^(BUTTON|A)$/.test(ae.tagName)) { ae.click(); }
    key(ae, 'keyup', k, k, {});
    return document.activeElement ? describe(document.activeElement) : null;
  }
  function blackout(selectors) {
    unblackout();
    var layer = document.createElement('div'); layer.id = '__cy_blackout'; layer.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:2147483645';
    var n = 0;
    (selectors || []).forEach(function (sel) { try { qsa(document, sel).forEach(function (e) { var r = e.getBoundingClientRect(); var b = document.createElement('div'); b.style.cssText = 'position:absolute;background:#000;left:' + (r.left + window.scrollX) + 'px;top:' + (r.top + window.scrollY) + 'px;width:' + r.width + 'px;height:' + r.height + 'px'; layer.appendChild(b); n += 1; }); } catch (x) { /* bad selector */ } });
    document.documentElement.appendChild(layer); return n;
  }
  function unblackout() { var l = document.getElementById('__cy_blackout'); if (l) l.remove(); return true; }
  function freeze(on) {
    var id = '__cy_freeze', cur = document.getElementById(id);
    if (!on) { if (cur) cur.remove(); return true; }
    if (!cur) { var s = document.createElement('style'); s.id = id; s.textContent = '*,*::before,*::after{animation:none !important;transition:none !important;caret-color:transparent !important}'; document.documentElement.appendChild(s); }
    return true;
  }
  function navStatus() {
    try { var n = performance.getEntriesByType('navigation')[0]; return { status: n && n.responseStatus ? n.responseStatus : 0, type: n ? n.type : '' }; } catch (e) { return { status: 0 }; }
  }
  function docMetrics() { return { sx: window.scrollX, sy: window.scrollY, w: window.innerWidth, h: window.innerHeight, sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight }; }
  function mark(steps, scope) {
    arr(document.querySelectorAll('[data-cy-target]')).forEach(function (e) { e.removeAttribute('data-cy-target'); });
    var els = resolve(steps, scope); els.forEach(function (e) { if (e.setAttribute) e.setAttribute('data-cy-target', '1'); });
    return els.length;
  }
  function unmark() { arr(document.querySelectorAll('[data-cy-target]')).forEach(function (e) { e.removeAttribute('data-cy-target'); }); return true; }
  function dom(cap) {
    var html = document.documentElement.outerHTML;
    if (html.length > cap) return null;
    return { html: html, url: location.href, w: window.innerWidth, h: window.innerHeight, sx: window.scrollX, sy: window.scrollY, title: document.title };
  }
  function hl(selector) {
    clearHl();
    var els = [];
    try { els = qsa(document, selector); } catch (e) { return { count: 0, error: e.message }; }
    var layer = document.createElement('div'); layer.id = '__cy_hl'; layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646';
    els.slice(0, 60).forEach(function (e) {
      var r = e.getBoundingClientRect();
      var b = document.createElement('div');
      b.style.cssText = 'position:fixed;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;background:rgba(159,196,231,.6);border:2px solid #4a90e2;box-sizing:border-box';
      layer.appendChild(b);
    });
    document.documentElement.appendChild(layer);
    if (els[0]) els[0].scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return { count: els.length, first: els[0] ? describe(els[0]) : null };
  }
  function clearHl() { var l = document.getElementById('__cy_hl'); if (l) l.remove(); return true; }

  /* ---------------- best selector (playground + recorder) ---------------- */
  function unique(sel) { try { return document.querySelectorAll(sel).length === 1; } catch (e) { return false; } }
  function bestSelector(el) {
    var tag = el.tagName.toLowerCase();
    var ATTRS = ['data-cy', 'data-test', 'data-testid', 'data-test-id', 'data-qa'];
    for (var i = 0; i < ATTRS.length; i += 1) { var v = el.getAttribute(ATTRS[i]); if (v) { var s = '[' + ATTRS[i] + '="' + v + '"]'; if (unique(s)) return { selector: s }; } }
    if (el.id && !/\d{3,}/.test(el.id)) { var s2 = '#' + esc(el.id); if (unique(s2)) return { selector: s2 }; }
    var NAMED = ['name', 'aria-label', 'placeholder', 'title', 'alt', 'href', 'for'];
    for (var j = 0; j < NAMED.length; j += 1) { var nv = el.getAttribute(NAMED[j]); if (nv && nv.length < 80) { var s3 = tag + '[' + NAMED[j] + '="' + nv.replace(/"/g, '\\"') + '"]'; if (unique(s3)) return { selector: s3 }; } }
    if (/^(BUTTON|A|LABEL|H1|H2|H3|H4|LI|SPAN|P|TD|TH|OPTION|SUMMARY)$/.test(el.tagName)) {
      var tx = norm(el.textContent);
      if (tx && tx.length <= 60) { var n = qsa(document, tag).filter(function (e) { return norm(e.textContent).indexOf(tx) >= 0; }).length; if (n >= 1) return { selector: tag, contains: tx }; }
    }
    var cls = (typeof el.className === 'string' ? el.className.trim().split(/\s+/) : []).filter(function (c) { return c && !/\d{2,}|^css-|^_|[A-Za-z0-9]{8,}$/.test(c) && c.length < 40; });
    for (var k = 1; k <= Math.min(2, cls.length); k += 1) { var s4 = tag + '.' + cls.slice(0, k).map(esc).join('.'); if (unique(s4)) return { selector: s4 }; }
    var path = [], node = el;
    while (node && node.nodeType === 1 && node !== document.body && path.length < 6) {
      var seg = node.tagName.toLowerCase();
      if (node.id && !/\d{3,}/.test(node.id)) { path.unshift('#' + esc(node.id)); break; }
      var sibs = node.parentElement ? arr(node.parentElement.children).filter(function (c) { return c.tagName === node.tagName; }) : [];
      if (sibs.length > 1) seg += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
      path.unshift(seg);
      var cand = path.join(' > '); if (unique(cand)) return { selector: cand };
      node = node.parentElement;
    }
    return { selector: path.join(' > ') };
  }

  /* ---------------- element picker (selector playground) ---------------- */
  var pickBox = null, pickHandlers = null;
  function startPicker() {
    stopPicker(); cy.picking = true; cy.picked = null;
    pickBox = document.createElement('div');
    pickBox.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;background:rgba(159,196,231,.5);border:2px solid #4a90e2;box-sizing:border-box;display:none';
    document.documentElement.appendChild(pickBox);
    var move = function (e) { var t = e.target; if (!t || t === pickBox) return; var r = t.getBoundingClientRect(); pickBox.style.display = 'block'; pickBox.style.left = r.left + 'px'; pickBox.style.top = r.top + 'px'; pickBox.style.width = r.width + 'px'; pickBox.style.height = r.height + 'px'; };
    var click = function (e) { e.preventDefault(); e.stopPropagation(); var b = bestSelector(e.target); cy.picked = Object.assign({ desc: describe(e.target) }, b); stopPicker(); };
    var kill = function (e) { e.preventDefault(); e.stopPropagation(); };
    pickHandlers = { move: move, click: click, kill: kill };
    document.addEventListener('mousemove', move, true); document.addEventListener('click', click, true);
    document.addEventListener('mousedown', kill, true); document.addEventListener('mouseup', kill, true); document.addEventListener('pointerdown', kill, true);
    return true;
  }
  function stopPicker() {
    if (pickHandlers) {
      document.removeEventListener('mousemove', pickHandlers.move, true); document.removeEventListener('click', pickHandlers.click, true);
      document.removeEventListener('mousedown', pickHandlers.kill, true); document.removeEventListener('mouseup', pickHandlers.kill, true); document.removeEventListener('pointerdown', pickHandlers.kill, true);
      pickHandlers = null;
    }
    if (pickBox) { pickBox.remove(); pickBox = null; }
    cy.picking = false; return true;
  }

  /* ---------------- recorder (Cypress Studio style) ---------------- */
  function recPush(ev) { ev.t = Date.now(); cy.rec.push(ev); try { sessionStorage.setItem('__cy_rec', JSON.stringify(cy.rec.slice(-300))); } catch (e) { /* storage may be blocked */ } }
  function recTarget(el) { var b = bestSelector(el); return b; }
  var recHandlers = null;
  function startRecording(reset) {
    if (reset) { cy.rec = []; try { sessionStorage.removeItem('__cy_rec'); } catch (e) { /* ignore */ } }
    else { try { cy.rec = JSON.parse(sessionStorage.getItem('__cy_rec') || '[]'); } catch (e) { cy.rec = []; } }
    try { sessionStorage.setItem('__cy_recording', '1'); } catch (e) { /* ignore */ }
    cy.recOn = true;
    if (recHandlers) return true;
    var lastClick = 0;
    recHandlers = {
      click: function (e) {
        if (!cy.recOn || cy.picking) return;
        var t = e.target; if (!t || !t.tagName || t.id === '__cy_hl') return;
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && /^(text|search|url|tel|password|email|number|)$/i.test(t.type || '') && t.tagName !== 'SELECT') return;
        if (t.tagName === 'SELECT' || t.tagName === 'OPTION') return;
        if (t.tagName === 'INPUT' && /^(checkbox|radio)$/i.test(t.type)) return;
        var now = Date.now(); if (now - lastClick < 40) return; lastClick = now;
        var tg = recTarget(t); recPush({ type: e.detail >= 2 ? 'dblclick' : 'click', selector: tg.selector, contains: tg.contains });
      },
      change: function (e) {
        if (!cy.recOn) return; var t = e.target; if (!t || !t.tagName) return;
        var tg = recTarget(t);
        if (t.tagName === 'SELECT') recPush({ type: 'select', selector: tg.selector, value: t.multiple ? arr(t.selectedOptions).map(function (o) { return o.text; }) : (t.selectedOptions[0] ? t.selectedOptions[0].text : t.value) });
        else if (t.tagName === 'INPUT' && /^(checkbox|radio)$/i.test(t.type)) recPush({ type: t.checked ? 'check' : 'uncheck', selector: tg.selector });
        else if (t.value !== undefined) recPush({ type: 'type', selector: tg.selector, value: t.value, secret: t.type === 'password' });
      },
      keydown: function (e) {
        if (!cy.recOn) return; var t = e.target; if (!t || !t.tagName) return;
        if (e.key === 'Enter' && /^(INPUT|TEXTAREA)$/.test(t.tagName) && t.tagName === 'INPUT') {
          // flush the typed value first (the change event comes with the blur)
          var tg = recTarget(t); var lastRec = cy.rec[cy.rec.length - 1];
          if (!lastRec || lastRec.type !== 'type' || lastRec.selector !== tg.selector || lastRec.value !== t.value) recPush({ type: 'type', selector: tg.selector, value: t.value, secret: t.type === 'password' });
          recPush({ type: 'press', selector: tg.selector, key: 'enter' });
        }
      },
    };
    document.addEventListener('click', recHandlers.click, true); document.addEventListener('change', recHandlers.change, true); document.addEventListener('keydown', recHandlers.keydown, true);
    return true;
  }
  function stopRecording() {
    cy.recOn = false;
    try { sessionStorage.removeItem('__cy_recording'); } catch (e) { /* ignore */ }
    if (recHandlers) { document.removeEventListener('click', recHandlers.click, true); document.removeEventListener('change', recHandlers.change, true); document.removeEventListener('keydown', recHandlers.keydown, true); recHandlers = null; }
    return cy.rec;
  }
  try { if (sessionStorage.getItem('__cy_recording')) document.addEventListener('DOMContentLoaded', function () { startRecording(false); }); } catch (e) { /* ignore */ }

  /* ---------------- errors, dialogs ---------------- */
  window.addEventListener('error', function (e) { cy.errors.push({ message: String(e.message || (e.error && e.error.message) || 'error'), stack: e.error && e.error.stack ? String(e.error.stack).slice(0, 800) : '', source: e.filename || '', line: e.lineno || 0, kind: 'error' }); });
  window.addEventListener('unhandledrejection', function (e) { var r = e.reason; cy.errors.push({ message: 'Unhandled promise rejection: ' + String(r && r.message ? r.message : r), stack: r && r.stack ? String(r.stack).slice(0, 800) : '', kind: 'rejection' }); });
  window.alert = function (m) { cy.dialogs.push({ type: 'alert', message: String(m) }); };
  window.confirm = function (m) { cy.dialogs.push({ type: 'confirm', message: String(m) }); return cy.opts.confirm !== false; };
  window.prompt = function (m, d) { cy.dialogs.push({ type: 'prompt', message: String(m) }); return cy.opts.promptValue != null ? cy.opts.promptValue : (d == null ? '' : d); };

  /* ---------------- network: intercept, spies, stubs ---------------- */
  function globRe(g) {
    var out = '', i = 0;
    while (i < g.length) {
      var c = g.charAt(i);
      if (c === '*' && g.charAt(i + 1) === '*') { out += '.*'; i += 2; continue; }
      if (c === '*') { out += '[^/]*'; i += 1; continue; }
      if (c === '?') { out += '[^/]'; i += 1; continue; }
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&'); i += 1;
    }
    return new RegExp('^' + out + '$');
  }
  function urlMatches(m, full) {
    if (m == null) return true;
    var u; try { u = new URL(full, location.href); } catch (e) { return false; }
    var cands = [u.href, u.pathname + u.search, u.pathname, u.origin + u.pathname];
    if (typeof m === 'object' && m.regex) { var re = new RegExp(m.regex, m.flags || ''); return cands.some(function (c) { return re.test(c); }); }
    var s = String(m);
    if (s.indexOf('*') >= 0 || s.indexOf('?') >= 0) { var g = globRe(s); return cands.some(function (c) { return g.test(c); }); }
    return cands.indexOf(s) >= 0 || u.href.replace(/\/$/, '') === s.replace(/\/$/, '');
  }
  function routeMatches(r, method, full, headers) {
    if (r.method && r.method.toUpperCase() !== method) return false;
    if (!urlMatches(r.url, full)) return false;
    if (r.pathname != null && !urlMatches(r.pathname, new URL(full, location.href).pathname)) return false;
    if (r.hostname != null && new URL(full, location.href).hostname !== r.hostname) return false;
    if (r.query) { var q = new URL(full, location.href).searchParams; for (var k in r.query) if (q.get(k) !== String(r.query[k])) return false; }
    if (r.headers) for (var h in r.headers) if (String(headers[h.toLowerCase()] || '').toLowerCase().indexOf(String(r.headers[h]).toLowerCase()) < 0) return false;
    return true;
  }
  function findRoute(method, full, headers) {
    for (var i = cy.routes.length - 1; i >= 0; i -= 1) {
      var r = cy.routes[i];
      if (r.times != null && r.used >= r.times) continue;
      if (routeMatches(r, method, full, headers)) return r;
    }
    return null;
  }
  function toBodyText(b) {
    if (b == null) return null;
    if (typeof b === 'string') return b;
    try { return JSON.stringify(b); } catch (e) { return String(b); }
  }
  function staticOf(spec, status, body, headers) {
    var resp = { statusCode: 200, body: '', headers: {}, delay: 0 };
    if (typeof spec === 'number') { resp.statusCode = spec; resp.body = body == null ? '' : body; resp.headers = headers || {}; }
    else if (typeof spec === 'string') resp.body = spec;
    else if (spec && typeof spec === 'object') {
      if ('statusCode' in spec || 'body' in spec || 'headers' in spec || 'fixture' in spec || 'forceNetworkError' in spec || 'delay' in spec || 'delayMs' in spec || 'throttleKbps' in spec) {
        resp.statusCode = spec.statusCode != null ? spec.statusCode : 200; resp.body = spec.body != null ? spec.body : ''; resp.headers = spec.headers || {}; resp.delay = spec.delay || spec.delayMs || 0; resp.forceNetworkError = !!spec.forceNetworkError;
      } else { resp.body = spec; }
    }
    var kbps = spec && typeof spec === 'object' ? (spec.throttleKbps || spec.throttle_kbps) : 0;
    if (kbps > 0) { var bytes = typeof resp.body === 'string' ? resp.body.length : JSON.stringify(resp.body || '').length; resp.delay = (resp.delay || 0) + Math.round(bytes * 8 / kbps); }
    if (resp.body != null && typeof resp.body === 'object') { resp.body = JSON.stringify(resp.body); if (!hasHeader(resp.headers, 'content-type')) resp.headers['content-type'] = 'application/json'; }
    return resp;
  }
  function hasHeader(h, name) { return Object.keys(h || {}).some(function (k) { return k.toLowerCase() === name; }); }
  function makeReq(call) {
    var u = new URL(call.url, location.href); var query = {}; u.searchParams.forEach(function (v, k) { query[k] = v; });
    var body = call.reqBody; try { body = body ? JSON.parse(body) : body; } catch (e) { /* keep text */ }
    return { method: call.method, url: u.href, headers: Object.assign({}, call.reqHeaders), body: body, query: query, alias: call.alias, _reply: null, _continue: null, _destroy: false,
      reply: function (a, b, c) { this._reply = staticOf(a, null, b, c); }, continue: function (cb) { this._continue = cb || true; }, destroy: function () { this._destroy = true; }, redirect: function (loc, st) { this._reply = { statusCode: st || 302, body: '', headers: { location: loc }, delay: 0 }; } };
  }
  function runHandler(route, call) {
    var req = makeReq(call);
    if (route.handler) { var fn; try { fn = (0, eval)('(' + route.handler + ')'); } catch (e) { fn = null; } if (fn) { try { fn(req); } catch (e) { cy.errors.push({ message: 'cy.intercept() handler threw: ' + e.message, stack: '', kind: 'handler' }); } } }
    if (req.alias) call.alias = req.alias;
    call.reqHeaders = req.headers;
    var nb = req.body; if (nb != null && typeof nb !== 'string') nb = JSON.stringify(nb); if (nb !== call.reqBody) call.reqBody = nb;
    return req;
  }
  function newCall(route, type, method, url, headers, body) {
    var c = { i: ++cy.seq, alias: route ? route.alias : null, route: route ? route.id : null, type: type, method: method, url: url, reqHeaders: headers || {}, reqBody: body == null ? null : toBodyText(body), status: 0, respHeaders: {}, respBody: null, stubbed: false, state: 'pending', t: Date.now(), dur: 0 };
    cy.calls.push(c); if (cy.calls.length > 500) cy.calls.shift();
    return c;
  }
  function finish(call, status, headers, body, stubbed) { call.status = status; call.respHeaders = headers || {}; call.respBody = body == null ? null : (typeof body === 'string' ? body.slice(0, 20000) : toBodyText(body)); call.stubbed = !!stubbed; call.state = status ? 'done' : 'error'; call.dur = Date.now() - call.t; }
  function hdrObj(h) { var o = {}; if (h && h.forEach) h.forEach(function (v, k) { o[k.toLowerCase()] = v; }); return o; }

  var realFetch = window.fetch ? window.fetch.bind(window) : null;
  if (realFetch) {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || String(input);
      var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      var headers = hdrObj(new Headers((init && init.headers) || (input && input.headers) || {}));
      var bodyP = init && init.body != null ? Promise.resolve(typeof init.body === 'string' ? init.body : (init.body instanceof URLSearchParams ? init.body.toString() : '[binary body]')) : (typeof Request !== 'undefined' && input instanceof Request ? input.clone().text().catch(function () { return null; }) : Promise.resolve(null));
      return bodyP.then(function (body) {
        var route = findRoute(method, url, headers);
        var call = newCall(route, 'fetch', method, new URL(url, location.href).href, headers, body);
        if (!route) return passthrough(call, input, init);
        route.used += 1;
        var req = runHandler(route, call);
        if (req._destroy || (route.response && route.response.forceNetworkError)) { finish(call, 0, {}, null, true); call.state = 'error'; return Promise.reject(new TypeError('Failed to fetch')); }
        var stub = req._reply || (route.response ? staticOf(route.response) : null);
        if (stub) {
          if (stub.forceNetworkError) { finish(call, 0, {}, null, true); return Promise.reject(new TypeError('Failed to fetch')); }
          return new Promise(function (res) { setTimeout(res, stub.delay || 0); }).then(function () {
            finish(call, stub.statusCode, lower(stub.headers), stub.body, true);
            return new Response(stub.statusCode === 204 || stub.statusCode === 304 ? null : stub.body, { status: stub.statusCode, headers: stub.headers });
          });
        }
        var init2 = Object.assign({}, init || {}); if (req.headers) init2.headers = req.headers; if (call.reqBody != null && init2.body != null) init2.body = call.reqBody;
        return passthrough(call, typeof input === 'string' ? input : input.url ? input.url : input, input instanceof Request && !init ? { method: input.method, headers: req.headers, body: call.reqBody } : init2, typeof req._continue === 'function' ? req._continue : null);
      });
    };
  }
  function lower(h) { var o = {}; Object.keys(h || {}).forEach(function (k) { o[k.toLowerCase()] = h[k]; }); return o; }
  function passthrough(call, input, init, after) {
    return realFetch(input, init).then(function (resp) {
      var c = resp.clone();
      c.text().then(function (t) { finish(call, resp.status, hdrObj(resp.headers), t, false); }).catch(function () { finish(call, resp.status, hdrObj(resp.headers), null, false); });
      if (after) {
        return resp.clone().text().then(function (t) {
          var res = { statusCode: resp.status, body: t, headers: hdrObj(resp.headers), send: function () {} };
          try { res.body = JSON.parse(t); } catch (e) { /* text */ }
          after(res);
          var b = res.body != null && typeof res.body !== 'string' ? JSON.stringify(res.body) : res.body;
          finish(call, res.statusCode, res.headers, b, true);
          return new Response(b, { status: res.statusCode, headers: res.headers });
        });
      }
      return resp;
    }, function (err) { finish(call, 0, {}, null, false); call.state = 'error'; throw err; });
  }

  var XO = XMLHttpRequest.prototype, realOpen = XO.open, realSend = XO.send, realSet = XO.setRequestHeader;
  XO.open = function (method, url) { this.__cy = { method: String(method).toUpperCase(), url: new URL(String(url), location.href).href, headers: {} }; return realOpen.apply(this, arguments); };
  XO.setRequestHeader = function (k, v) { if (this.__cy) this.__cy.headers[String(k).toLowerCase()] = String(v); return realSet.apply(this, arguments); };
  XO.send = function (body) {
    var x = this, meta = x.__cy;
    if (!meta) return realSend.apply(this, arguments);
    var route = findRoute(meta.method, meta.url, meta.headers);
    var call = newCall(route, 'xhr', meta.method, meta.url, meta.headers, body);
    var done = function (stubbed) {
      var h = {}; (x.getAllResponseHeaders() || '').trim().split(/\r?\n/).forEach(function (l) { var ix = l.indexOf(':'); if (ix > 0) h[l.slice(0, ix).trim().toLowerCase()] = l.slice(ix + 1).trim(); });
      var text = null; try { text = x.responseType === '' || x.responseType === 'text' ? x.responseText : (x.responseType === 'json' ? JSON.stringify(x.response) : null); } catch (e) { /* binary */ }
      finish(call, x.status, h, text, stubbed);
    };
    if (!route) { x.addEventListener('loadend', function () { done(false); }); return realSend.apply(this, arguments); }
    route.used += 1;
    var req = runHandler(route, call);
    var stub = req._reply || (route.response ? staticOf(route.response) : null);
    if (req._destroy || (stub && stub.forceNetworkError)) { setTimeout(function () { finish(call, 0, {}, null, true); try { Object.defineProperty(x, 'readyState', { value: 4, configurable: true }); } catch (e) { /* ignore */ } x.dispatchEvent(new ProgressEvent('error')); x.dispatchEvent(new ProgressEvent('loadend')); }, 0); return; }
    if (!stub) { x.addEventListener('loadend', function () { done(typeof req._continue === 'function'); }); return realSend.apply(this, arguments); }
    setTimeout(function () {
      var rb = stub.body, rh = lower(stub.headers);
      var def = function (k, v) { try { Object.defineProperty(x, k, { value: v, configurable: true }); } catch (e) { /* ignore */ } };
      def('readyState', 4); def('status', stub.statusCode); def('statusText', String(stub.statusCode)); def('responseURL', meta.url);
      def('responseText', typeof rb === 'string' ? rb : toBodyText(rb));
      def('response', x.responseType === 'json' ? (function () { try { return JSON.parse(rb); } catch (e) { return null; } })() : (typeof rb === 'string' ? rb : toBodyText(rb)));
      def('getResponseHeader', function (n) { return rh[String(n).toLowerCase()] == null ? null : rh[String(n).toLowerCase()]; });
      def('getAllResponseHeaders', function () { return Object.keys(rh).map(function (k) { return k + ': ' + rh[k]; }).join('\r\n'); });
      finish(call, stub.statusCode, rh, typeof rb === 'string' ? rb : toBodyText(rb), true);
      ['readystatechange', 'load', 'loadend'].forEach(function (n) { try { x.dispatchEvent(new ProgressEvent(n)); } catch (e) { /* ignore */ } });
      if (typeof x.onreadystatechange === 'function') { try { x.onreadystatechange(new Event('readystatechange')); } catch (e) { /* app error */ } }
    }, stub.delay || 0);
  };

  function setRoutes(list) {
    // keep usage counters of routes that already existed
    var used = {}; cy.routes.forEach(function (r) { used[r.id] = r.used; });
    cy.routes = (list || []).map(function (r) { return Object.assign({}, r, { used: used[r.id] || 0 }); });
    return cy.routes.length;
  }
  function callsSince(from, alias) {
    return cy.calls.filter(function (c) { return c.i > from && (!alias || c.alias === alias); });
  }
  function resetCalls() { cy.calls = []; cy.seq = 0; return true; }

  /* ---------------- spies on page functions ---------------- */
  function getPath(root, path) { var o = root; String(path).split('.').filter(Boolean).forEach(function (p) { o = o == null ? undefined : o[p]; }); return o; }
  function safe(v) { try { return JSON.parse(JSON.stringify(v === undefined ? null : v)); } catch (e) { return String(v); } }
  function spy(path, method, impl) {
    var obj = path ? getPath(window, path) : window;
    if (!obj || typeof obj[method] !== 'function') throw new Error('cy.spy()/cy.stub() could not find a function at ' + (path ? path + '.' : 'window.') + method);
    var id = ++cy.spySeq, orig = obj[method];
    var rec = cy.spies[id] = { id: id, calls: [], path: path, method: method, restore: function () { obj[method] = orig; } };
    obj[method] = function () { var args = arr(arguments); rec.calls.push({ args: args.map(safe), at: Date.now() }); if (impl !== undefined && impl !== null) { try { return (0, eval)('(' + impl + ')').apply(this, args); } catch (e) { return undefined; } } return impl === null ? orig.apply(this, arguments) : undefined; };
    return id;
  }
  function spyCalls(id) { var s = cy.spies[id]; return s ? s.calls : []; }
  function spyRestore(id) { var s = cy.spies[id]; if (s) { s.restore(); delete cy.spies[id]; } return true; }

  /* ---------------- fake clock ---------------- */
  function clockInstall(now, only) {
    clockRestore();
    var real = { Date: window.Date, setTimeout: window.setTimeout, clearTimeout: window.clearTimeout, setInterval: window.setInterval, clearInterval: window.clearInterval, rAF: window.requestAnimationFrame, perf: performance.now.bind(performance) };
    var st = cy.clock = { now: now, start: now, id: 1, timers: [], real: real };
    var want = function (n) { return !only || only.indexOf(n) >= 0; };
    if (want('Date')) {
      var RD = real.Date;
      var FD = function () { var a = arguments; if (!(this instanceof FD)) return new RD(st.now).toString(); return a.length ? new (Function.prototype.bind.apply(RD, [null].concat(arr(a))))() : new RD(st.now); };
      FD.prototype = RD.prototype; FD.now = function () { return st.now; }; FD.parse = RD.parse; FD.UTC = RD.UTC;
      window.Date = FD;
    }
    var add = function (fn, ms, repeat, args) { var id = st.id++; st.timers.push({ id: id, fn: fn, at: st.now + Math.max(0, +ms || 0), every: repeat ? Math.max(1, +ms || 0) : 0, args: args }); return id; };
    if (want('setTimeout')) window.setTimeout = function (fn, ms) { return add(fn, ms, false, slice.call(arguments, 2)); };
    if (want('setInterval')) window.setInterval = function (fn, ms) { return add(fn, ms, true, slice.call(arguments, 2)); };
    var clear = function (id) { st.timers = st.timers.filter(function (t) { return t.id !== id; }); };
    if (want('clearTimeout')) window.clearTimeout = clear; if (want('clearInterval')) window.clearInterval = clear;
    if (want('requestAnimationFrame')) { window.requestAnimationFrame = function (fn) { return add(function () { fn(st.now); }, 16, false, []); }; window.cancelAnimationFrame = clear; }
    return st.now;
  }
  function clockTick(ms) {
    var st = cy.clock; if (!st) throw new Error('cy.tick() cannot be called without first calling cy.clock()');
    var end = st.now + ms;
    for (var guard = 0; guard < 10000; guard += 1) {
      var due = st.timers.filter(function (t) { return t.at <= end; }).sort(function (a, b) { return a.at - b.at || a.id - b.id; })[0];
      if (!due) break;
      st.now = due.at;
      if (due.every) due.at += due.every; else st.timers = st.timers.filter(function (t) { return t !== due; });
      try { if (typeof due.fn === 'function') due.fn.apply(window, due.args || []); } catch (e) { cy.errors.push({ message: e.message, stack: '', kind: 'timer' }); }
    }
    st.now = end; return st.now;
  }
  function clockRestore() {
    var st = cy.clock; if (!st) return true;
    window.Date = st.real.Date; window.setTimeout = st.real.setTimeout; window.clearTimeout = st.real.clearTimeout; window.setInterval = st.real.setInterval; window.clearInterval = st.real.clearInterval;
    if (st.real.rAF) window.requestAnimationFrame = st.real.rAF;
    cy.clock = null; return true;
  }

  /* ---------------- page-level helpers used by commands ---------------- */
  function cookies() {
    return document.cookie ? document.cookie.split('; ').map(function (c) { var i = c.indexOf('='); return { name: decodeURIComponent(c.slice(0, i)), value: decodeURIComponent(c.slice(i + 1)), domain: location.hostname, path: '/' }; }) : [];
  }
  function setCookie(name, value, o) {
    o = o || {};
    var s = encodeURIComponent(name) + '=' + encodeURIComponent(value) + '; path=' + (o.path || '/');
    if (o.expiry) s += '; expires=' + new Date(o.expiry * 1000).toUTCString();
    if (o.secure) s += '; secure';
    if (o.sameSite) s += '; samesite=' + o.sameSite;
    document.cookie = s; return true;
  }
  function clearCookies(name) {
    cookies().forEach(function (c) { if (!name || c.name === name) document.cookie = encodeURIComponent(c.name) + '=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT'; });
    return true;
  }
  function storeDump() {
    var l = {}, s = {};
    try { for (var i = 0; i < localStorage.length; i += 1) { var k = localStorage.key(i); l[k] = localStorage.getItem(k); } } catch (e) { /* blocked */ }
    try { for (var j = 0; j < sessionStorage.length; j += 1) { var k2 = sessionStorage.key(j); if (k2.indexOf('__cy_') !== 0) s[k2] = sessionStorage.getItem(k2); } } catch (e) { /* blocked */ }
    return { origin: location.origin, local: l, session: s, cookies: cookies() };
  }
  function storeRestore(d) {
    try { localStorage.clear(); Object.keys(d.local || {}).forEach(function (k) { localStorage.setItem(k, d.local[k]); }); } catch (e) { /* blocked */ }
    try { Object.keys(sessionStorage).forEach(function (k) { if (k.indexOf('__cy_') !== 0) sessionStorage.removeItem(k); }); Object.keys(d.session || {}).forEach(function (k) { sessionStorage.setItem(k, d.session[k]); }); } catch (e) { /* blocked */ }
    clearCookies(); (d.cookies || []).forEach(function (c) { setCookie(c.name, c.value); });
    return true;
  }
  function clearStorage(which, key) {
    try {
      if (which === 'local' || which === 'all') { if (key) localStorage.removeItem(key); else localStorage.clear(); }
      if (which === 'session' || which === 'all') { Object.keys(sessionStorage).forEach(function (k) { if (k.indexOf('__cy_') !== 0 && (!key || k === key)) sessionStorage.removeItem(k); }); }
    } catch (e) { /* blocked */ }
    return true;
  }
  function evalPath(path, args, call) {
    var parts = String(path || '').split('.').filter(Boolean), o = window, parent = null;
    for (var i = 0; i < parts.length; i += 1) { parent = o; o = o == null ? undefined : o[parts[i]]; }
    if (call) { if (typeof o !== 'function') throw new Error('cy.invoke() expected ' + path + ' to be a function'); return safe(o.apply(parent, args || [])); }
    return safe(o);
  }
  function evalScript(src) { return safe((0, eval)(src)); }
  function info() { return { url: location.href, hash: location.hash, host: location.host, hostname: location.hostname, href: location.href, origin: location.origin, pathname: location.pathname, port: location.port, protocol: location.protocol, search: location.search, title: document.title, ready: document.readyState, w: window.innerWidth, h: window.innerHeight }; }
  function readyState() { return document.readyState; }

  var API = { snap: snap, act: act, mark: mark, unmark: unmark, dom: dom, hl: hl, clearHl: clearHl, startPicker: startPicker, stopPicker: stopPicker, picked: function () { var p = cy.picked; return { picking: cy.picking, picked: p || null }; },
    startRecording: startRecording, stopRecording: stopRecording, rec: function () { return { on: cy.recOn, events: cy.rec }; }, clearRec: function () { cy.rec = []; try { sessionStorage.removeItem('__cy_rec'); } catch (e) { /* ignore */ } return true; },
    setRoutes: setRoutes, calls: function (from, alias) { return callsSince(from || 0, alias); }, resetCalls: resetCalls, lastSeq: function () { return cy.seq; },
    spy: spy, spyCalls: spyCalls, spyRestore: spyRestore, clockInstall: clockInstall, clockTick: clockTick, clockRestore: clockRestore,
    cookies: cookies, setCookie: setCookie, clearCookies: clearCookies, storeDump: storeDump, storeRestore: storeRestore, clearStorage: clearStorage,
    evalPath: evalPath, evalScript: evalScript, info: info, readyState: readyState, dialogs: function () { var d = cy.dialogs; cy.dialogs = []; return d; }, setOpts: function (o) { Object.assign(cy.opts, o); return true; },
    rect: rectOf, selectAll: selectAll, caret: caret, pressKey: pressKey, blackout: blackout, unblackout: unblackout, freeze: freeze, navStatus: navStatus, metrics: docMetrics,
    best: function (steps) { var els = resolve(steps); return els[0] ? bestSelector(els[0]) : null; }, count: function (sel) { try { return qsa(document, sel).length; } catch (e) { return -1; } },
    styles: function (steps, scope, props) { var els = resolve(steps, scope); return els[0] ? snapEl(els[0], props).css : null; } };
  cy.call = function (name, args) {
    var out = { r: null, e: null, n: cy.nav };
    try { out.r = API[name].apply(null, args || []); } catch (err) { out.x = String(err && err.message ? err.message : err); }
    if (cy.errors.length) { out.e = cy.errors.splice(0, cy.errors.length); }
    return JSON.stringify(out);
  };
})();
