// overlay.js — 注入到 iframe 内部
// 三种选区模式：点选（point）/ 框选（rect）/ 文本选区（text）
// + 悬停检查（实时显示 selector 标签）
(function () {
  'use strict';
  if (window.__PPT_VE_OVERLAY__) return;
  window.__PPT_VE_OVERLAY__ = true;

  // ============ 样式 ============
  const css = `
    .ppt-ve-hover { outline: 2px solid #4f8cff !important; outline-offset: -1px !important; cursor: crosshair !important; }
    .ppt-ve-selected { outline: 3px solid #fb923c !important; outline-offset: -2px !important; box-shadow: 0 0 0 9999px rgba(251,146,60,.08) !important; }
    .ppt-ve-tag {
      position: fixed; z-index: 99999; pointer-events: none;
      background: rgba(10,12,16,.92); color: #fff; font: 11px/1.4 -apple-system, monospace;
      padding: 3px 8px; border-radius: 4px; white-space: nowrap;
      box-shadow: 0 4px 12px rgba(0,0,0,.4); backdrop-filter: blur(8px);
      max-width: 360px; overflow: hidden; text-overflow: ellipsis;
      border: 1px solid rgba(255,255,255,.1);
    }
    .ppt-ve-tag .anchor { color: #a5b4fc; font-weight: 600; }
    .ppt-ve-tag .sel { color: #fed7aa; font-family: ui-monospace, monospace; font-size: 10px; }
    .ppt-ve-marquee {
      position: fixed; z-index: 99998; pointer-events: none;
      background: rgba(99,102,241,.1);
      border: 1px dashed #6366f1;
    }
    .ppt-ve-pseudo-hl {
      position: fixed; z-index: 99997; pointer-events: none;
      background: rgba(245, 158, 11, .12);
      border: 2px solid #fbbf24;
      box-shadow: 0 0 0 9999px rgba(0,0,0,.06);
    }
    .ppt-ve-rect-hit {
      outline: 2px dashed #6366f1 !important; outline-offset: -1px !important;
      background: rgba(99,102,241,.06) !important;
    }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // ============ 选择器算法（与 lib/selector-computer.js 同源） ============
  const SEMANTIC_CLASS = /^(slide|header|body|foot|footer|slot|slot-title|slot-body|kicker|title|subtitle|shape|shape-title|funnel|stage|tree|node|timeline|stat|card|grid|item|badge|tag|btn|button|icon|container|row|col|cell|nav|menu|link)$/i;
  const IGNORE_CLASS = /^(hover|active|focus|hidden|visible|disabled|selected|hl|highlight|ppt-ve-\w+)$/i;

  function isSemanticClass(cls) {
    if (!cls) return false;
    if (IGNORE_CLASS.test(cls)) return false;
    if (/[a-z]+-[a-z]+/.test(cls) && !/^(text|bg|border|padding|margin|font|size|w|h|p|m)-/.test(cls)) return true;
    return SEMANTIC_CLASS.test(cls);
  }
  function escapeId(id) { return id ? id.replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c) : null; }
  function escapeAttr(v) { return String(v).replace(/"/g, '\\"'); }

  function describeSegment(el, parent) {
    const aiId = el.getAttribute && el.getAttribute('data-ai-id');
    if (aiId) return { sel: `[data-ai-id="${escapeAttr(aiId)}"]`, anchor: 'data-ai-id' };
    if (el.id && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(el.id) && !/^(:|react|ember|vue|__|ppt-ve)/.test(el.id)) {
      return { sel: `#${escapeId(el.id)}`, anchor: 'id' };
    }
    const slot = el.getAttribute && el.getAttribute('data-slot');
    if (slot) return { sel: `[data-slot="${escapeAttr(slot)}"]`, anchor: 'data-slot' };
    const tag = el.tagName.toLowerCase();
    const classes = Array.from(el.classList || []).filter(isSemanticClass);
    if (classes.length > 0) {
      const picked = classes.slice(0, 2).map((c) => '.' + c).join('');
      let sel = picked;
      if (parent) {
        const sameClassSibs = Array.from(parent.children).filter((s) => s !== el && classes.every((c) => s.classList.contains(c)));
        if (sameClassSibs.length > 0) {
          const idx = Array.from(parent.children).indexOf(el) + 1;
          sel = `${picked}:nth-child(${idx})`;
        }
      }
      return { sel, anchor: 'class' };
    }
    let sel = tag;
    if (parent) {
      const idx = Array.from(parent.children).indexOf(el) + 1;
      sel = `${tag}:nth-child(${idx})`;
    }
    return { sel, anchor: 'tag' };
  }

  function computeSelector(el) {
    if (!el || el.nodeType !== 1) return null;
    const chain = [];
    let cur = el; let depth = 0; const MAX = 6;
    while (cur && cur.nodeType === 1 && cur !== document.body && cur !== document.documentElement && depth < MAX) {
      const seg = describeSegment(cur, cur.parentElement);
      chain.unshift(seg);
      if (seg.anchor === 'data-ai-id' || seg.anchor === 'id' || seg.anchor === 'data-slot') break;
      cur = cur.parentElement;
      depth++;
    }
    return { css: chain.map((s) => s.sel).join(' '), chain, anchor: chain[0] ? chain[0].anchor : null };
  }

  // ============ DOM helpers ============
  function getOuterHtml(el) {
    const clone = el.cloneNode(false);
    // 剥离 overlay 注入的临时 class，避免污染上下文包
    if (clone.classList) {
      const toRemove = Array.from(clone.classList).filter((c) => c.startsWith('ppt-ve-'));
      toRemove.forEach((c) => clone.classList.remove(c));
      if (clone.classList.length === 0) clone.removeAttribute('class');
    }
    const text = (el.textContent || '').trim();
    if (text && el.children.length === 0) {
      clone.textContent = text.length > 120 ? text.slice(0, 120) + '…' : text;
    } else if (el.children.length > 0) {
      clone.innerHTML = '<!-- children omitted -->';
    }
    return clone.outerHTML;
  }
  function getSiblings(el) {
    const out = [];
    if (el.previousElementSibling) out.push({ relation: '上邻', html: brief(el.previousElementSibling) });
    if (el.nextElementSibling) out.push({ relation: '下邻', html: brief(el.nextElementSibling) });
    return out;
  }
  function brief(el) { return getOuterHtml(el).replace(/\s+/g, ' ').slice(0, 240); }

  // ============ 状态 ============
  let mode = 'point'; // 'point' | 'rect' | 'text'
  let lastHover = null;
  let tagEl = null;
  let marqueeEl = null;
  let pseudoHlEl = null; // 伪元素精确高亮框
  let rectStart = null;
  let rectHits = new Set();

  function clearHover() {
    if (lastHover) { lastHover.classList.remove('ppt-ve-hover'); lastHover = null; }
    if (tagEl) { tagEl.remove(); tagEl = null; }
    if (pseudoHlEl) { pseudoHlEl.style.display = 'none'; }
  }

  // 计算伪元素的视口 rect（基于宿主 rect + CSS 的 absolute/fixed 定位 + transform）
  function getPseudoRect(el, pseudo) {
    const cs = getComputedStyle(el, pseudo);
    if (cs.display === 'none' || cs.visibility === 'hidden') return null;
    // 只有 absolute/fixed 才能精确算（relative/static 的伪元素在文档流内不好定位）
    if (cs.position !== 'absolute' && cs.position !== 'fixed') return null;
    const w = parseFloat(cs.width);
    const h = parseFloat(cs.height);
    if (isNaN(w) || isNaN(h) || w === 0 || h === 0) return null;
    const hostRect = el.getBoundingClientRect();
    let topPx = cs.top !== 'auto' ? parseFloat(cs.top) : null;
    let leftPx = cs.left !== 'auto' ? parseFloat(cs.left) : null;
    if (leftPx === null && cs.right !== 'auto') {
      leftPx = hostRect.width - parseFloat(cs.right) - w;
    }
    if (topPx === null && cs.bottom !== 'auto') {
      topPx = hostRect.height - parseFloat(cs.bottom) - h;
    }
    if (topPx === null || leftPx === null) return null;
    // 解析 transform matrix(a,b,c,d,e,f) 的 e/f 作为 translate
    let tx = 0, ty = 0;
    const m = (cs.transform || '').match(/matrix\(([^)]+)\)/);
    if (m) {
      const parts = m[1].split(',').map(parseFloat);
      tx = parts[4] || 0;
      ty = parts[5] || 0;
    }
    return {
      x: hostRect.left + leftPx + tx,
      y: hostRect.top + topPx + ty,
      w, h,
    };
  }

  // 找鼠标位置下宿主元素的可见伪元素（如果有）
  function findPseudoAt(el, x, y) {
    for (const pseudo of ['::before', '::after']) {
      const cs = getComputedStyle(el, pseudo);
      if (!cs.content || cs.content === 'none' || cs.content === 'normal') continue;
      const r = getPseudoRect(el, pseudo);
      if (!r) continue;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
        return { pseudo, rect: r, content: cs.content.replace(/^"|"$/g, '') };
      }
    }
    return null;
  }

  function ensurePseudoHl() {
    if (!pseudoHlEl) {
      pseudoHlEl = document.createElement('div');
      pseudoHlEl.className = 'ppt-ve-pseudo-hl';
      pseudoHlEl.style.display = 'none';
      document.body.appendChild(pseudoHlEl);
    }
    return pseudoHlEl;
  }

  function showTag(el, selector) {
    if (!tagEl) {
      tagEl = document.createElement('div');
      tagEl.className = 'ppt-ve-tag';
      document.body.appendChild(tagEl);
    }
    const r = el.getBoundingClientRect();
    const anchorName = { 'data-ai-id': 'data-ai-id', 'id': 'id', 'data-slot': 'data-slot', 'class': 'class', 'tag': 'tag' }[selector.anchor] || selector.anchor;
    tagEl.innerHTML = `<span class="anchor">${anchorName}</span> <span class="sel">${escapeHtml(selector.css)}</span>`;
    tagEl.style.left = Math.min(r.left, window.innerWidth - 380) + 'px';
    tagEl.style.top = (r.top < 24 ? r.bottom + 4 : r.top - 24) + 'px';
  }

  function escapeHtml(s) { return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function post(payload) {
    payload.type = 'select';
    payload.text = (payload.element?.textContent || '').trim().slice(0, 80);
    window.parent.postMessage(payload, '*');
  }

  // 收集宿主元素的 ::before / ::after 伪元素信息
  // 仅返回 content 非 none/空 且 display 非 none 的可见伪元素
  function collectPseudoElements(el) {
    const result = [];
    for (const pseudo of ['::before', '::after']) {
      const cs = getComputedStyle(el, pseudo);
      const content = cs.content;
      // content 可能是 "→" / "★" / none / normal / url(...)
      if (!content || content === 'none' || content === 'normal') continue;
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const info = {
        pseudo,
        content: content.replace(/^"|"$/g, ''), // 去掉 CSS 引号
        display: cs.display,
        position: cs.position,
        width: cs.width,
        height: cs.height,
        background: cs.backgroundImage !== 'none' ? cs.backgroundImage : (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' ? cs.backgroundColor : null),
        color: cs.color,
        border: (cs.borderTopWidth !== '0px' || cs.borderWidth !== '0px') ? `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}` : null,
        fontSize: cs.fontSize,
      };
      result.push(info);
    }
    return result;
  }

  // 在点击位置收集可见的伪元素：
  // 1) 用 elementsFromPoint 拿到该位置层叠的所有元素
  // 2) 对每个元素 + 其祖先链（向上 5 层）扫伪元素
  // 解决"伪元素是宿主外 absolute 定位，click target 不是宿主"的场景
  function collectPseudoAtPoint(x, y) {
    const result = [];
    const seen = new Set();
    const stack = [];
    try {
      const els = document.elementsFromPoint(x, y);
      for (const el of els) stack.push(el);
    } catch {}
    while (stack.length) {
      let el = stack.shift();
      let depth = 0;
      while (el && el !== document.body && depth < 5) {
        let hostSel = '(unknown)';
        try { hostSel = computeSelector(el).css; } catch {}
        for (const p of collectPseudoElements(el)) {
          const key = hostSel + '|' + p.pseudo;
          if (seen.has(key)) { el = el.parentElement; depth++; continue; }
          seen.add(key);
          // 尝试算伪元素视口 rect（absolute/fixed 才有），方便定位
          const prect = getPseudoRect(el, p.pseudo);
          result.push({ ...p, host: hostSel, hostTag: el.tagName.toLowerCase(), rect: prect ? { x: Math.round(prect.x), y: Math.round(prect.y), w: Math.round(prect.w), h: Math.round(prect.h) } : null });
        }
        el = el.parentElement;
        depth++;
      }
    }
    return result;
  }

  function selectElement(el, rect, ev) {
    if (!el || el === document.body || el === document.documentElement) return;
    document.querySelectorAll('.ppt-ve-selected').forEach((e) => e.classList.remove('ppt-ve-selected'));
    el.classList.add('ppt-ve-selected');
    const selector = computeSelector(el);
    const hostRect = el.getBoundingClientRect();
    const hostRectObj = { x: Math.round(hostRect.x), y: Math.round(hostRect.y), w: Math.round(hostRect.width), h: Math.round(hostRect.height) };
    const pseudo = ev ? collectPseudoAtPoint(ev.clientX, ev.clientY) : collectPseudoFromAncestors(el);
    // 如果命中了伪元素且能算出 rect，主 rect 用伪元素的，宿主 rect 单独放 hostRect
    const hit = pseudo.find((p) => p.rect);
    const primaryRect = hit ? hit.rect : hostRectObj;
    post({
      selector,
      elementHtml: getOuterHtml(el),
      element: { textContent: el.textContent || '' },
      siblings: getSiblings(el),
      pseudo,
      rect: primaryRect,
      hostRect: hit ? hostRectObj : undefined,
    });
  }

  // 祖先链扫描（无鼠标事件坐标时的 fallback）
  function collectPseudoFromAncestors(el, maxDepth = 5) {
    const result = [];
    const seen = new Set();
    let cur = el;
    let depth = 0;
    while (cur && cur !== document.body && depth < maxDepth) {
      let hostSel = '(unknown)';
      try { hostSel = computeSelector(cur).css; } catch {}
      for (const p of collectPseudoElements(cur)) {
        const key = hostSel + '|' + p.pseudo;
        if (seen.has(key)) { cur = cur.parentElement; depth++; continue; }
        seen.add(key);
        result.push({ ...p, host: hostSel, hostTag: cur.tagName.toLowerCase() });
      }
      cur = cur.parentElement;
      depth++;
    }
    return result;
  }

  // ============ Mode handlers ============
  function handleClick(ev) {
    window.parent.postMessage({ type: 'ppt-ve-debug', msg: `click target=${ev.target?.tagName} mode=${mode} altKey=${ev.altKey} shiftKey=${ev.shiftKey}` }, '*');
    if (mode === 'point') {
      // 点选模式：Option/Alt + 点击
      if (!ev.altKey) {
        window.parent.postMessage({ type: 'ppt-ve-debug', msg: 'point 模式需要按住 Option/Alt 键才点击' }, '*');
        return;
      }
      ev.preventDefault(); ev.stopPropagation();
      selectElement(ev.target, null, ev);
    }
    // rect 模式下 click 不做事，靠 mousedown/move/up
  }

  function handleMouseDown(ev) {
    if (mode !== 'rect') return;
    if (ev.button !== 0) return;
    ev.preventDefault();
    rectStart = { x: ev.clientX, y: ev.clientY };
    if (!marqueeEl) {
      marqueeEl = document.createElement('div');
      marqueeEl.className = 'ppt-ve-marquee';
      document.body.appendChild(marqueeEl);
    }
    marqueeEl.style.left = rectStart.x + 'px';
    marqueeEl.style.top = rectStart.y + 'px';
    marqueeEl.style.width = '0px';
    marqueeEl.style.height = '0px';
    marqueeEl.style.display = 'block';

    document.addEventListener('mousemove', handleRectMove, true);
    document.addEventListener('mouseup', handleRectUp, true);
  }

  function handleRectMove(ev) {
    if (!rectStart || !marqueeEl) return;
    const x = Math.min(ev.clientX, rectStart.x);
    const y = Math.min(ev.clientY, rectStart.y);
    const w = Math.abs(ev.clientX - rectStart.x);
    const h = Math.abs(ev.clientY - rectStart.y);
    marqueeEl.style.left = x + 'px';
    marqueeEl.style.top = y + 'px';
    marqueeEl.style.width = w + 'px';
    marqueeEl.style.height = h + 'px';

    // 实时高亮命中元素
    document.querySelectorAll('.ppt-ve-rect-hit').forEach((e) => e.classList.remove('ppt-ve-rect-hit'));
    rectHits.clear();
    const all = document.body.querySelectorAll('*');
    const r1 = { x, y, w, h };
    for (const el of all) {
      if (el === marqueeEl || el.classList.contains('ppt-ve-tag')) continue;
      const r = el.getBoundingClientRect();
      // 中心点是否在 marquee 内
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      if (cx >= r1.x && cx <= r1.x + r1.w && cy >= r1.y && cy <= r1.y + r1.h) {
        // 排除被父元素完全包含的元素（只保留最深 / 最小的命中）
        rectHits.add(el);
      }
    }
    // 简化：只高亮命中元素的最小可点击子集（移除被其他命中元素包含的）
    const arr = Array.from(rectHits).filter((el) => {
      for (const other of rectHits) {
        if (other === el) continue;
        if (other.contains(el)) {
          // el 是 other 的后代 — 保留更深的 el，但如果 el 太小（< 8x8）跳过
          return el.getBoundingClientRect().width >= 8 && el.getBoundingClientRect().height >= 8;
        }
      }
      return true;
    });
    arr.forEach((e) => e.classList.add('ppt-ve-rect-hit'));
    rectHits = new Set(arr);
  }

  function handleRectUp(ev) {
    document.removeEventListener('mousemove', handleRectMove, true);
    document.removeEventListener('mouseup', handleRectUp, true);
    if (marqueeEl) { marqueeEl.style.display = 'none'; }
    // 收集命中元素，发回父窗口
    if (rectHits.size === 0) { rectStart = null; return; }
    const hits = Array.from(rectHits);
    // 如果只有一个，作为单选；多个，作为多选
    const payload = {
      selector: computeSelector(hits[0]),
      elementHtml: getOuterHtml(hits[0]),
      siblings: getSiblings(hits[0]),
      pseudo: collectPseudoFromAncestors(hits[0]),
      rect: rectFromEl(hits[0]),
      multi: hits.slice(0, 10).map((el) => ({
        selector: computeSelector(el),
        elementHtml: getOuterHtml(el),
        rect: rectFromEl(el),
      })),
    };
    post(payload);
    // 高亮
    document.querySelectorAll('.ppt-ve-rect-hit').forEach((e) => e.classList.remove('ppt-ve-rect-hit'));
    rectHits.clear();
    rectStart = null;
  }

  function rectFromEl(el) {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  }

  // ============ Mousemove for hover tag (point mode) ============
  function handleMouseMove(ev) {
    if (mode !== 'point') { clearHover(); return; }
    const el = ev.target;
    if (!el || el === document.body || el === document.documentElement || el.classList?.contains('ppt-ve-tag') || el === marqueeEl) {
      clearHover(); return;
    }

    // 先检测：鼠标是否落在某个伪元素的视觉区域上
    const pseudoHit = findPseudoAt(el, ev.clientX, ev.clientY);
    if (pseudoHit) {
      // 高亮伪元素本身（精确小框）
      clearHover();
      el.classList.add('ppt-ve-hover');
      lastHover = el;
      const hl = ensurePseudoHl();
      hl.style.display = '';
      hl.style.left = pseudoHit.rect.x + 'px';
      hl.style.top = pseudoHit.rect.y + 'px';
      hl.style.width = pseudoHit.rect.w + 'px';
      hl.style.height = pseudoHit.rect.h + 'px';
      // tag 显示伪元素信息
      const hostSel = computeSelector(el);
      showPseudoTag(pseudoHit, hostSel, el);
      return;
    }

    if (el === lastHover) {
      // 位置可能变化，刷新标签位置
      return;
    }
    clearHover();
    el.classList.add('ppt-ve-hover');
    lastHover = el;
    const selector = computeSelector(el);
    showTag(el, selector);
  }

  function showPseudoTag(hit, hostSel, hostEl) {
    if (!tagEl) {
      tagEl = document.createElement('div');
      tagEl.className = 'ppt-ve-tag';
      document.body.appendChild(tagEl);
    }
    tagEl.innerHTML = `<span class="anchor">${hit.pseudo}</span> <span class="sel">content: ${hit.content} · host: ${hostSel.css || ''}</span>`;
    const r = hit.rect;
    tagEl.style.left = Math.min(r.x, window.innerWidth - 380) + 'px';
    tagEl.style.top = (r.y < 24 ? r.y + r.h + 4 : r.y - 24) + 'px';
  }

  // ============ Text mode: rely on native selection ============
  function handleSelectionChange() {
    if (mode !== 'text') return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const text = sel.toString();
    if (!text) return;
    let node = sel.anchorNode;
    let el = node.nodeType === 3 ? node.parentElement : node;
    if (!el) return;
    // 向上找首个有语义的祖先
    let cur = el;
    let depth = 0;
    while (cur && cur !== document.body && depth < 4) {
      if (cur.getAttribute && (cur.getAttribute('data-ai-id') || cur.getAttribute('data-slot') || cur.id)) {
        el = cur; break;
      }
      const classes = Array.from(cur.classList || []).filter(isSemanticClass);
      if (classes.length > 0) { el = cur; break; }
      cur = cur.parentElement;
      depth++;
    }
    const selector = computeSelector(el);
    post({
      selector,
      elementHtml: getOuterHtml(el),
      siblings: getSiblings(el),
      pseudo: collectPseudoFromAncestors(el),
      rect: rectFromEl(el),
      selectedText: text.slice(0, 200),
    });
    sel.removeAllRanges();
  }

  // ============ Bindings ============
  window.parent.postMessage({ type: 'ppt-ve-debug', msg: `[overlay] loaded, mode=${mode}, hasParent=${window.parent !== window}` }, '*');
  document.addEventListener('click', handleClick, true);
  document.addEventListener('mousedown', handleMouseDown, true);
  document.addEventListener('mousemove', handleMouseMove, true);
  document.addEventListener('selectionchange', handleSelectionChange);

  // Listen for parent commands
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d) return;
    if (d.type === 'ppt-ve-mode') {
      mode = d.mode;
      clearHover();
      document.querySelectorAll('.ppt-ve-selected, .ppt-ve-rect-hit').forEach((e) => {
        e.classList.remove('ppt-ve-selected');
        e.classList.remove('ppt-ve-rect-hit');
      });
    } else if (d.type === 'ppt-ve-clear') {
      document.querySelectorAll('.ppt-ve-selected').forEach((e) => e.classList.remove('ppt-ve-selected'));
    } else if (d.type === 'ppt-ve-highlight') {
      // 给定 selector 高亮一个元素
      try {
        const el = document.querySelector(d.selector);
        if (el) {
          document.querySelectorAll('.ppt-ve-selected').forEach((e) => e.classList.remove('ppt-ve-selected'));
          el.classList.add('ppt-ve-selected');
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      } catch {}
    }
  });

  console.log('[ppt-ve] overlay loaded. mode=point');
})();
