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
      // mark 模式开关画板
      if (mode === 'mark') enableMarkBoard();
      else disableMarkBoard();
    } else if (d.type === 'ppt-ve-clear') {
      document.querySelectorAll('.ppt-ve-selected').forEach((e) => e.classList.remove('ppt-ve-selected'));
    } else if (d.type === 'ppt-ve-highlight') {
      try {
        const el = document.querySelector(d.selector);
        if (el) {
          document.querySelectorAll('.ppt-ve-selected').forEach((e) => e.classList.remove('ppt-ve-selected'));
          el.classList.add('ppt-ve-selected');
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      } catch {}
    } else if (d.type === 'ppt-ve-mark-tool') {
      markTool = d.tool || 'rect';
      markColor = d.color || markColor;
      markStrokeWidth = d.strokeWidth || markStrokeWidth;
      applyMarkCursor();
    } else if (d.type === 'ppt-ve-mark-image-src') {
      currentImageSrc = d.src;
      // 自动切到 image 工具
      markTool = 'image';
      applyMarkCursor();
    } else if (d.type === 'ppt-ve-redraw-marks') {
      marks = Array.isArray(d.marks) ? d.marks : [];
      renderMarks();
    } else if (d.type === 'ppt-ve-clear-marks') {
      marks = [];
      renderMarks();
    } else if (d.type === 'ppt-ve-mark-undo') {
      undo();
    } else if (d.type === 'ppt-ve-mark-redo') {
      redo();
    }
  });

  console.log('[ppt-ve] overlay loaded. mode=point');

  // ============ Paste 图片转发（iframe 内 paste 不冒泡到父窗口） ============
  window.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items || [];
    for (const it of items) {
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) {
          e.preventDefault();
          // 把图片转 base64 转发给父窗口（避免 File 对象无法跨 window 传递）
          const reader = new FileReader();
          reader.onload = () => {
            window.parent.postMessage({
              type: 'ppt-ve-image-paste',
              dataUrl: reader.result,
              mime: f.type,
              filename: f.name || 'pasted.png',
            }, '*');
          };
          reader.readAsDataURL(f);
          return;
        }
      }
    }
  });

  // ============ Mark Board（画板层） ============
  // 进入 mark 模式时注入顶层 SVG 画板，支持矩形/文字（Phase A）
  // 箭头/画笔在 Phase B 加
  let markBoard = null;
  let markTool = 'rect';
  let markColor = '#ef4444';
  let markStrokeWidth = 2;
  let currentImageSrc = null; // mark image 工具当前关联的图片 src
  let marks = []; // 数据模型
  let drawing = false;
  let drawStart = null;
  let draftEl = null;
  let draftPoints = null;

  const MARKBOARD_STYLE = `
    #ve-markboard {
      position: fixed !important;
      top: 0 !important; left: 0 !important;
      width: 100vw !important; height: 100vh !important;
      z-index: 99990 !important;
      pointer-events: none;
      cursor: default;
      color: initial;
      font: initial;
      background: transparent;
    }
    #ve-markboard.active { pointer-events: auto; }
    #ve-markboard text { font-family: -apple-system, system-ui, sans-serif; user-select: none; }
    #ve-markboard .ve-mark { cursor: pointer; }
    #ve-markboard .ve-mark:hover { filter: drop-shadow(0 0 4px rgba(0,0,0,0.5)); }
  `;

  function ensureMarkStyle() {
    if (document.getElementById('ve-mark-style')) return;
    const s = document.createElement('style');
    s.id = 've-mark-style';
    s.textContent = MARKBOARD_STYLE;
    document.head.appendChild(s);
  }

  function ensureMarkBoard() {
    ensureMarkStyle();
    if (markBoard) return markBoard;
    markBoard = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    markBoard.setAttribute('id', 've-markboard');
    markBoard.setAttribute('width', '100%');
    markBoard.setAttribute('height', '100%');
    document.body.appendChild(markBoard);
    // 绑定画板事件
    markBoard.addEventListener('mousedown', onMarkMouseDown);
    markBoard.addEventListener('mousemove', onMarkMouseMove);
    window.addEventListener('mouseup', onMarkMouseUp);
    return markBoard;
  }

  function enableMarkBoard() {
    ensureMarkBoard();
    markBoard.classList.add('active');
    applyMarkCursor();
    renderMarks();
  }

  function disableMarkBoard() {
    if (!markBoard) return;
    markBoard.classList.remove('active');
  }

  function applyMarkCursor() {
    if (!markBoard) return;
    const cursors = { rect: 'crosshair', text: 'text', arrow: 'crosshair', pen: 'crosshair', image: 'crosshair' };
    markBoard.style.cursor = cursors[markTool] || 'crosshair';
  }

  function svgPt(ev) {
    // 转换鼠标坐标到 SVG 路径需要的 viewport 坐标
    return { x: ev.clientX, y: ev.clientY };
  }

  function onMarkMouseDown(ev) {
    if (!markBoard || !markBoard.classList.contains('active')) return;
    if (ev.button !== 0) return;
    // Option/Alt + 点击：临时穿透 markBoard，选取底层元素（复用 point 模式的 selectElement）
    if (ev.altKey) {
      ev.preventDefault(); ev.stopPropagation();
      const x = ev.clientX, y = ev.clientY;
      markBoard.style.pointerEvents = 'none';
      const realTarget = document.elementFromPoint(x, y);
      markBoard.style.pointerEvents = '';
      if (realTarget && realTarget !== markBoard && realTarget !== document.body && realTarget !== document.documentElement) {
        selectElement(realTarget, null, ev);
      }
      return;
    }
    const p = svgPt(ev);
    const ns = 'http://www.w3.org/2000/svg';
    if (markTool === 'text') {
      const text = window.prompt('输入标注文字：');
      if (text && text.trim()) {
        const m = {
          id: 'mk_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          type: 'text',
          x: p.x, y: p.y,
          text: text.trim(),
          fontSize: 14,
          color: markColor,
          ts: Date.now(),
        };
        pushUndo();
        marks.push(m);
        renderMarks();
        notifyMarkCreated(m);
      }
      return;
    }
    drawing = true;
    drawStart = p;
    draftPoints = null;
    if (markTool === 'rect' || markTool === 'image') {
      draftEl = document.createElementNS(ns, 'rect');
      draftEl.setAttribute('x', p.x);
      draftEl.setAttribute('y', p.y);
      draftEl.setAttribute('width', 0);
      draftEl.setAttribute('height', 0);
      draftEl.setAttribute('fill', 'none');
      draftEl.setAttribute('stroke', markColor);
      draftEl.setAttribute('stroke-width', markStrokeWidth);
      draftEl.setAttribute('stroke-dasharray', '4 2');
      markBoard.appendChild(draftEl);
    } else if (markTool === 'arrow') {
      draftEl = document.createElementNS(ns, 'line');
      draftEl.setAttribute('x1', p.x); draftEl.setAttribute('y1', p.y);
      draftEl.setAttribute('x2', p.x); draftEl.setAttribute('y2', p.y);
      draftEl.setAttribute('stroke', markColor);
      draftEl.setAttribute('stroke-width', markStrokeWidth);
      draftEl.setAttribute('stroke-linecap', 'round');
      markBoard.appendChild(draftEl);
    } else if (markTool === 'pen') {
      draftPoints = [p];
      draftEl = document.createElementNS(ns, 'polyline');
      draftEl.setAttribute('points', `${p.x},${p.y}`);
      draftEl.setAttribute('fill', 'none');
      draftEl.setAttribute('stroke', markColor);
      draftEl.setAttribute('stroke-width', markStrokeWidth);
      draftEl.setAttribute('stroke-linecap', 'round');
      draftEl.setAttribute('stroke-linejoin', 'round');
      markBoard.appendChild(draftEl);
    }
  }

  function onMarkMouseMove(ev) {
    if (!drawing) return;
    const p = svgPt(ev);
    if ((markTool === 'rect' || markTool === 'image') && draftEl && drawStart) {
      const x = Math.min(drawStart.x, p.x);
      const y = Math.min(drawStart.y, p.y);
      const w = Math.abs(p.x - drawStart.x);
      const h = Math.abs(p.y - drawStart.y);
      draftEl.setAttribute('x', x);
      draftEl.setAttribute('y', y);
      draftEl.setAttribute('width', w);
      draftEl.setAttribute('height', h);
    } else if (markTool === 'arrow' && draftEl && drawStart) {
      draftEl.setAttribute('x2', p.x);
      draftEl.setAttribute('y2', p.y);
    } else if (markTool === 'pen' && draftEl && draftPoints) {
      draftPoints.push(p);
      // 简化：采样间隔，避免点太密
      const last = draftPoints[draftPoints.length - 2];
      if (Math.hypot(p.x - last.x, p.y - last.y) < 2) {
        draftPoints.pop();
        return;
      }
      draftEl.setAttribute('points', draftPoints.map((q) => `${q.x},${q.y}`).join(' '));
    }
  }

  function onMarkMouseUp(ev) {
    if (!drawing) return;
    drawing = false;
    const p = svgPt(ev);
    const baseId = 'mk_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    if (markTool === 'rect' && draftEl && drawStart) {
      const x = Math.min(drawStart.x, p.x);
      const y = Math.min(drawStart.y, p.y);
      const w = Math.abs(p.x - drawStart.x);
      const h = Math.abs(p.y - drawStart.y);
      if (w >= 6 && h >= 6) {
        const m = { id: baseId, type: 'rect', x, y, w, h, stroke: markColor, strokeWidth: markStrokeWidth, ts: Date.now() };
        pushUndo();
        marks.push(m);
        notifyMarkCreated(m);
      }
    } else if (markTool === 'arrow' && draftEl && drawStart) {
      const len = Math.hypot(p.x - drawStart.x, p.y - drawStart.y);
      if (len >= 8) {
        const m = { id: baseId, type: 'arrow', x1: drawStart.x, y1: drawStart.y, x2: p.x, y2: p.y, stroke: markColor, strokeWidth: markStrokeWidth, ts: Date.now() };
        pushUndo();
        marks.push(m);
        notifyMarkCreated(m);
      }
    } else if (markTool === 'pen' && draftEl && draftPoints) {
      if (draftPoints.length >= 2) {
        const m = { id: baseId, type: 'pen', points: draftPoints.map((q) => [q.x, q.y]), stroke: markColor, strokeWidth: markStrokeWidth, ts: Date.now() };
        pushUndo();
        marks.push(m);
        notifyMarkCreated(m);
      }
    } else if (markTool === 'image' && draftEl && drawStart) {
      const x = Math.min(drawStart.x, p.x);
      const y = Math.min(drawStart.y, p.y);
      const w = Math.abs(p.x - drawStart.x);
      const h = Math.abs(p.y - drawStart.y);
      if (w >= 20 && h >= 20 && currentImageSrc) {
        const m = { id: baseId, type: 'image', x, y, w, h, src: currentImageSrc, ts: Date.now() };
        pushUndo();
        marks.push(m);
        notifyMarkCreated(m);
      } else if (!currentImageSrc) {
        window.parent.postMessage({ type: 'ppt-ve-debug', msg: 'image 工具未关联图片 src（需先在 pendingBar 点画板）' }, '*');
      }
    }
    if (draftEl && draftEl.parentNode) draftEl.parentNode.removeChild(draftEl);
    draftEl = null;
    drawStart = null;
    draftPoints = null;
    renderMarks();
  }

  function renderMarks() {
    if (!markBoard) return;
    // 清除现有 mark 节点（保留 draftEl，不过 draftEl 已经被 up 时移除）
    const old = markBoard.querySelectorAll('.ve-mark');
    old.forEach((n) => n.remove());
    // 重绘
    for (const m of marks) {
      const node = createMarkNode(m);
      if (node) {
        node.classList.add('ve-mark');
        node.dataset.id = m.id;
        // Shift+Click 直接删除
        node.addEventListener('click', (e) => {
          if (e.shiftKey) {
            e.stopPropagation();
            pushUndo();
            marks = marks.filter((x) => x.id !== m.id);
            selectedMarkId = null;
            renderMarks();
            notifyMarkSync();
          }
        });
        // 拖拽移动（非 Shift 时按下即进入拖拽）
        node.addEventListener('mousedown', (e) => {
          if (e.shiftKey || e.button !== 0) return;
          if (!markBoard.classList.contains('active')) return;
          e.stopPropagation();
          startDragMove(e, m);
        });
        markBoard.appendChild(node);
      }
    }
  }

  // —— 拖拽移动标记 ——
  let dragMove = null; // { mark, startMouse, origMark }
  function startDragMove(ev, m) {
    selectedMarkId = m.id;
    pushUndo();
    dragMove = {
      mark: m,
      startMouse: { x: ev.clientX, y: ev.clientY },
      origMark: JSON.parse(JSON.stringify(m)),
    };
    const onMove = (e) => {
      if (!dragMove) return;
      const dx = e.clientX - dragMove.startMouse.x;
      const dy = e.clientY - dragMove.startMouse.y;
      const o = dragMove.origMark;
      const t = dragMove.mark;
      if (t.type === 'rect') {
        t.x = o.x + dx; t.y = o.y + dy;
      } else if (t.type === 'text') {
        t.x = o.x + dx; t.y = o.y + dy;
      } else if (t.type === 'image') {
        t.x = o.x + dx; t.y = o.y + dy;
      } else if (t.type === 'arrow') {
        t.x1 = o.x1 + dx; t.y1 = o.y1 + dy;
        t.x2 = o.x2 + dx; t.y2 = o.y2 + dy;
      } else if (t.type === 'pen' && Array.isArray(o.points)) {
        t.points = o.points.map(([x, y]) => [x + dx, y + dy]);
      }
      renderMarks();
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (dragMove) notifyMarkSync();
      dragMove = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  // —— 拖拽缩放标记（仅 image / rect，右下角 handle）——
  let dragResize = null; // { mark, startMouse, origMark }
  function startResize(ev, m) {
    selectedMarkId = m.id;
    pushUndo();
    dragResize = {
      mark: m,
      startMouse: { x: ev.clientX, y: ev.clientY },
      origMark: JSON.parse(JSON.stringify(m)),
    };
    const onMove = (e) => {
      if (!dragResize) return;
      const dx = e.clientX - dragResize.startMouse.x;
      const dy = e.clientY - dragResize.startMouse.y;
      const o = dragResize.origMark;
      const t = dragResize.mark;
      const minSize = 20;
      if (t.type === 'image' || t.type === 'rect') {
        t.w = Math.max(minSize, o.w + dx);
        t.h = Math.max(minSize, o.h + dy);
      }
      renderMarks();
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (dragResize) notifyMarkSync();
      dragResize = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function createMarkNode(m) {
    const ns = 'http://www.w3.org/2000/svg';
    if (m.type === 'rect') {
      const r = document.createElementNS(ns, 'rect');
      r.setAttribute('x', m.x);
      r.setAttribute('y', m.y);
      r.setAttribute('width', m.w);
      r.setAttribute('height', m.h);
      r.setAttribute('fill', 'none');
      r.setAttribute('stroke', m.stroke || '#ef4444');
      r.setAttribute('stroke-width', m.strokeWidth || 2);
      r.setAttribute('rx', 2);
      return r;
    }
    if (m.type === 'text') {
      const t = document.createElementNS(ns, 'text');
      t.setAttribute('x', m.x);
      t.setAttribute('y', m.y);
      t.setAttribute('fill', m.color || '#ef4444');
      t.setAttribute('font-size', m.fontSize || 14);
      t.setAttribute('font-weight', 600);
      // 背景：用 paint-order 描边模拟背景，便于在彩色图片上可读
      t.setAttribute('stroke', '#fff');
      t.setAttribute('stroke-width', 3);
      t.setAttribute('paint-order', 'stroke');
      t.textContent = m.text;
      return t;
    }
    if (m.type === 'arrow') {
      const g = document.createElementNS(ns, 'g');
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', m.x1); line.setAttribute('y1', m.y1);
      line.setAttribute('x2', m.x2); line.setAttribute('y2', m.y2);
      line.setAttribute('stroke', m.stroke || '#ef4444');
      line.setAttribute('stroke-width', m.strokeWidth || 2);
      line.setAttribute('stroke-linecap', 'round');
      g.appendChild(line);
      // 箭头头部三角形
      const dx = m.x2 - m.x1, dy = m.y2 - m.y1;
      const len = Math.hypot(dx, dy);
      if (len > 0.1) {
        const headLen = 10 + ((m.strokeWidth || 2) - 1) * 2;
        const ux = dx / len, uy = dy / len;
        const px = -uy, py = ux;
        const baseX = m.x2 - ux * headLen;
        const baseY = m.y2 - uy * headLen;
        const halfW = headLen * 0.45;
        const tri = document.createElementNS(ns, 'polygon');
        tri.setAttribute('points', `${m.x2},${m.y2} ${baseX + px * halfW},${baseY + py * halfW} ${baseX - px * halfW},${baseY - py * halfW}`);
        tri.setAttribute('fill', m.stroke || '#ef4444');
        g.appendChild(tri);
      }
      return g;
    }
    if (m.type === 'pen' && Array.isArray(m.points) && m.points.length >= 2) {
      const poly = document.createElementNS(ns, 'polyline');
      poly.setAttribute('points', m.points.map(([x, y]) => `${x},${y}`).join(' '));
      poly.setAttribute('fill', 'none');
      poly.setAttribute('stroke', m.stroke || '#ef4444');
      poly.setAttribute('stroke-width', m.strokeWidth || 2);
      poly.setAttribute('stroke-linecap', 'round');
      poly.setAttribute('stroke-linejoin', 'round');
      return poly;
    }
    if (m.type === 'image' && m.src) {
      const g = document.createElementNS(ns, 'g');
      const img = document.createElementNS(ns, 'image');
      img.setAttribute('x', m.x);
      img.setAttribute('y', m.y);
      img.setAttribute('width', m.w);
      img.setAttribute('height', m.h);
      img.setAttribute('preserveAspectRatio', 'none');
      img.setAttributeNS('http://www.w3.org/1999/xlink', 'href', m.src);
      img.setAttribute('href', m.src);
      g.appendChild(img);
      // 虚线边框便于辨识
      const border = document.createElementNS(ns, 'rect');
      border.setAttribute('x', m.x);
      border.setAttribute('y', m.y);
      border.setAttribute('width', m.w);
      border.setAttribute('height', m.h);
      border.setAttribute('fill', 'none');
      border.setAttribute('stroke', '#3b82f6');
      border.setAttribute('stroke-width', '1');
      border.setAttribute('stroke-dasharray', '4 2');
      g.appendChild(border);
      // 右下角 resize handle（蓝色实心方块）
      const hs = 8;
      const handle = document.createElementNS(ns, 'rect');
      handle.setAttribute('x', m.x + m.w - hs / 2);
      handle.setAttribute('y', m.y + m.h - hs / 2);
      handle.setAttribute('width', hs);
      handle.setAttribute('height', hs);
      handle.setAttribute('fill', '#3b82f6');
      handle.setAttribute('stroke', '#fff');
      handle.setAttribute('stroke-width', '1');
      handle.style.cursor = 'nwse-resize';
      handle.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (!markBoard.classList.contains('active')) return;
        e.stopPropagation();
        startResize(e, m);
      });
      g.appendChild(handle);
      return g;
    }
    return null;
  }

  function notifyMarkCreated(m) {
    window.parent.postMessage({ type: 'mark:created', mark: m }, '*');
  }
  function notifyMarkDeleted(id) {
    window.parent.postMessage({ type: 'mark:deleted', id }, '*');
  }
  function notifyMarkSync() {
    window.parent.postMessage({ type: 'mark:sync', marks }, '*');
  }

  // ============ Undo / Redo ============
  // 每次标记变化前 push 一份 snapshot，限制 50 步
  const undoStack = [];
  const redoStack = [];
  const MAX_UNDO = 50;
  let selectedMarkId = null;

  function snapshot() {
    return JSON.parse(JSON.stringify(marks));
  }
  function pushUndo() {
    undoStack.push(snapshot());
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack.length = 0; // 新动作清空 redo
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    marks = undoStack.pop();
    renderMarks();
    notifyMarkSync();
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshot());
    marks = redoStack.pop();
    renderMarks();
    notifyMarkSync();
  }

  // 在 mark 创建/删除前调 pushUndo
  // 改写 notifyMarkCreated / 调用方在 push mark 前手动 pushUndo
  // 简化：监听 mark 操作
  const origNotifyCreated = notifyMarkCreated;
  // 不重写：在 onMarkMouseDown/Up 处显式调
  function deleteMark(id) {
    pushUndo();
    marks = marks.filter((m) => m.id !== id);
    renderMarks();
    notifyMarkSync();
  }

  // 键盘快捷键（仅 mark 模式激活时）
  document.addEventListener('keydown', (ev) => {
    if (!markBoard || !markBoard.classList.contains('active')) return;
    // Ctrl/Cmd + Z 撤销
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') {
      ev.preventDefault();
      if (ev.shiftKey) redo(); else undo();
      return;
    }
    // Ctrl/Cmd + Y 重做
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'y') {
      ev.preventDefault();
      redo();
      return;
    }
    // Delete / Backspace 删除选中
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && selectedMarkId) {
      ev.preventDefault();
      deleteMark(selectedMarkId);
      selectedMarkId = null;
    }
  }, true);

  // 暴露给外部调试
  window.__veMarkDebug__ = { getMarks: () => marks };
})();
