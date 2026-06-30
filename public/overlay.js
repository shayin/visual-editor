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
      // 预加载拿原始宽高比，初始绘制时锁比例
      currentImageRatio = null;
      if (d.src) {
        const probe = new Image();
        probe.onload = () => {
          if (probe.naturalWidth && probe.naturalHeight) {
            currentImageRatio = probe.naturalWidth / probe.naturalHeight;
          }
        };
        probe.src = d.src;
      }
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
  let currentImageRatio = null; // 当前图片原始宽高比，初始绘制锁比例用
  let marks = []; // 数据模型
  let drawing = false;
  let drawStart = null;
  let draftEl = null;
  let draftPoints = null;
  // 裁剪模式状态
  let cropTargetId = null; // 当前正在裁剪的 image mark id；null = 未在裁剪模式
  let cropDraft = null; // { x, y, w, h } SVG 坐标，裁剪框当前位置
  let cropDrag = null; // { dir, startMouse, origRect }

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
    // 裁剪模式期间，禁止其他绘制/拖动（避免误操作背景标记）
    if (cropTargetId) return;
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
    if (markTool === 'rect' && draftEl && drawStart) {
      const x = Math.min(drawStart.x, p.x);
      const y = Math.min(drawStart.y, p.y);
      const w = Math.abs(p.x - drawStart.x);
      const h = Math.abs(p.y - drawStart.y);
      draftEl.setAttribute('x', x);
      draftEl.setAttribute('y', y);
      draftEl.setAttribute('width', w);
      draftEl.setAttribute('height', h);
    } else if (markTool === 'image' && draftEl && drawStart) {
      // 初始绘制锁原始比例（按主导方向）
      const r = currentImageRatio || 1;
      const rawW = Math.abs(p.x - drawStart.x);
      const rawH = Math.abs(p.y - drawStart.y);
      let w, h;
      if (rawW >= rawH * r) { w = rawW; h = w / r; }
      else { h = rawH; w = h * r; }
      let x = drawStart.x, y = drawStart.y;
      if (p.x < drawStart.x) x = drawStart.x - w;
      if (p.y < drawStart.y) y = drawStart.y - h;
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
      // 初始绘制锁原始比例
      const r = currentImageRatio || 1;
      const rawW = Math.abs(p.x - drawStart.x);
      const rawH = Math.abs(p.y - drawStart.y);
      let w, h;
      if (rawW >= rawH * r) { w = rawW; h = w / r; }
      else { h = rawH; w = h * r; }
      let x = drawStart.x, y = drawStart.y;
      if (p.x < drawStart.x) x = drawStart.x - w;
      if (p.y < drawStart.y) y = drawStart.y - h;
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
    // 裁剪模式 overlay（蒙版 + 裁剪框 + handle + 顶栏）
    renderCropOverlay();
  }

  // ============ 裁剪模式 ============
  function enterCropMode(markId) {
    const m = marks.find((x) => x.id === markId);
    if (!m || m.type !== 'image') return;
    selectedMarkId = markId;
    cropTargetId = markId;
    // 裁剪框初始位置：当前 crop 的可见区，没 crop 就是整张
    if (m.crop) {
      cropDraft = {
        x: m.x + (m.crop.xr || 0) * m.w,
        y: m.y + (m.crop.yr || 0) * m.h,
        w: m.crop.wr * m.w,
        h: m.crop.hr * m.h,
      };
    } else {
      cropDraft = { x: m.x, y: m.y, w: m.w, h: m.h };
    }
    renderMarks();
  }

  function exitCropMode(commit) {
    const m = marks.find((x) => x.id === cropTargetId);
    if (commit && m && cropDraft) {
      // 转成 0..1 比例写入 mark.crop
      const xr = (cropDraft.x - m.x) / m.w;
      const yr = (cropDraft.y - m.y) / m.h;
      const wr = cropDraft.w / m.w;
      const hr = cropDraft.h / m.h;
      // 几乎等于整张图就清掉 crop
      const isFull = xr <= 0.005 && yr <= 0.005 && wr >= 0.995 && hr >= 0.995;
      if (isFull) {
        delete m.crop;
      } else {
        m.crop = { xr, yr, wr, hr };
      }
      pushUndo();
      notifyMarkSync();
    }
    cropTargetId = null;
    cropDraft = null;
    cropDrag = null;
    renderMarks();
  }

  function renderCropOverlay() {
    // 清除旧 overlay
    const oldOverlay = markBoard.querySelectorAll('.ve-crop-overlay');
    oldOverlay.forEach((n) => n.remove());
    if (!cropTargetId) return;
    const m = marks.find((x) => x.id === cropTargetId);
    if (!m || !cropDraft) return;

    const og = document.createElementNS(ns, 'g');
    og.classList.add('ve-crop-overlay');

    // 1) 半透明黑色蒙版：图片区四周围（裁剪框外）4 块
    const mx = cropDraft.x, my = cropDraft.y, mw = cropDraft.w, mh = cropDraft.h;
    const masks = [
      // 上：图片顶到裁剪框顶
      [m.x, m.y, m.w, Math.max(0, my - m.y)],
      // 下：裁剪框底到图片底
      [m.x, my + mh, m.w, Math.max(0, (m.y + m.h) - (my + mh))],
      // 左：图片左到裁剪框左（高度=裁剪框高）
      [m.x, my, Math.max(0, mx - m.x), mh],
      // 右：裁剪框右到图片右
      [mx + mw, my, Math.max(0, (m.x + m.w) - (mx + mw)), mh],
    ];
    masks.forEach(([x, y, w, h]) => {
      if (w <= 0 || h <= 0) return;
      const r = document.createElementNS(ns, 'rect');
      r.setAttribute('x', x); r.setAttribute('y', y);
      r.setAttribute('width', w); r.setAttribute('height', h);
      r.setAttribute('fill', '#000');
      r.setAttribute('opacity', '0.45');
      r.setAttribute('pointer-events', 'none');
      og.appendChild(r);
    });

    // 2) 裁剪框边框（绿色虚线）
    const cb = document.createElementNS(ns, 'rect');
    cb.setAttribute('x', mx); cb.setAttribute('y', my);
    cb.setAttribute('width', mw); cb.setAttribute('height', mh);
    cb.setAttribute('fill', 'none');
    cb.setAttribute('stroke', '#10b981');
    cb.setAttribute('stroke-width', '1.5');
    cb.setAttribute('stroke-dasharray', '4 2');
    og.appendChild(cb);

    // 3) 8 个裁剪 handle
    const hs = 9;
    const cursorMap = {
      nw: 'nwse-resize', se: 'nwse-resize',
      ne: 'nesw-resize', sw: 'nesw-resize',
      n: 'ns-resize', s: 'ns-resize',
      e: 'ew-resize', w: 'ew-resize',
    };
    const handles = [
      ['nw', mx,        my       ],
      ['n',  mx + mw/2, my       ],
      ['ne', mx + mw,   my       ],
      ['e',  mx + mw,   my + mh/2],
      ['se', mx + mw,   my + mh  ],
      ['s',  mx + mw/2, my + mh  ],
      ['sw', mx,        my + mh  ],
      ['w',  mx,        my + mh/2],
    ];
    handles.forEach(([dir, cx, cy]) => {
      const h = document.createElementNS(ns, 'rect');
      h.setAttribute('x', cx - hs / 2);
      h.setAttribute('y', cy - hs / 2);
      h.setAttribute('width', hs);
      h.setAttribute('height', hs);
      h.setAttribute('fill', '#10b981');
      h.setAttribute('stroke', '#fff');
      h.setAttribute('stroke-width', '1');
      h.setAttribute('rx', 1);
      h.style.cursor = cursorMap[dir];
      h.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
        startCropDrag(e, dir);
      });
      og.appendChild(h);
    });

    // 4) 顶栏：标题 + 完成按钮 + 取消按钮（位于图片上方）
    const barH = 22;
    const barW = 180;
    const barX = m.x + m.w - barW;
    const barY = m.y - barH - 6;
    const bar = document.createElementNS(ns, 'rect');
    bar.setAttribute('x', barX); bar.setAttribute('y', barY);
    bar.setAttribute('width', barW); bar.setAttribute('height', barH);
    bar.setAttribute('fill', '#1f2937');
    bar.setAttribute('rx', 4);
    bar.setAttribute('pointer-events', 'none');
    og.appendChild(bar);
    const title = document.createElementNS(ns, 'text');
    title.setAttribute('x', barX + 8);
    title.setAttribute('y', barY + 15);
    title.setAttribute('fill', '#fff');
    title.setAttribute('font-size', '11');
    title.setAttribute('pointer-events', 'none');
    title.textContent = '裁剪（Esc 取消）';
    og.appendChild(title);

    const okBtn = document.createElementNS(ns, 'g');
    const okX = barX + barW - 60;
    const okRect = document.createElementNS(ns, 'rect');
    okRect.setAttribute('x', okX); okRect.setAttribute('y', barY + 3);
    okRect.setAttribute('width', 26); okRect.setAttribute('height', barH - 6);
    okRect.setAttribute('fill', '#10b981');
    okRect.setAttribute('rx', 3);
    okRect.style.cursor = 'pointer';
    const okTx = document.createElementNS(ns, 'text');
    okTx.setAttribute('x', okX + 13);
    okTx.setAttribute('y', barY + 15);
    okTx.setAttribute('text-anchor', 'middle');
    okTx.setAttribute('fill', '#fff');
    okTx.setAttribute('font-size', '11');
    okTx.setAttribute('pointer-events', 'none');
    okTx.textContent = '完成';
    okRect.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      exitCropMode(true);
    });
    okBtn.appendChild(okRect);
    okBtn.appendChild(okTx);
    og.appendChild(okBtn);

    const noBtn = document.createElementNS(ns, 'g');
    const noX = barX + barW - 30;
    const noRect = document.createElementNS(ns, 'rect');
    noRect.setAttribute('x', noX); noRect.setAttribute('y', barY + 3);
    noRect.setAttribute('width', 26); noRect.setAttribute('height', barH - 6);
    noRect.setAttribute('fill', '#6b7280');
    noRect.setAttribute('rx', 3);
    noRect.style.cursor = 'pointer';
    const noTx = document.createElementNS(ns, 'text');
    noTx.setAttribute('x', noX + 13);
    noTx.setAttribute('y', barY + 15);
    noTx.setAttribute('text-anchor', 'middle');
    noTx.setAttribute('fill', '#fff');
    noTx.setAttribute('font-size', '11');
    noTx.setAttribute('pointer-events', 'none');
    noTx.textContent = '取消';
    noRect.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      exitCropMode(false);
    });
    noBtn.appendChild(noRect);
    noBtn.appendChild(noTx);
    og.appendChild(noBtn);

    markBoard.appendChild(og);
  }

  // 裁剪 handle 拖动：在 mark 矩形内 clamp
  function startCropDrag(ev, dir) {
    cropDrag = {
      dir,
      startMouse: { x: ev.clientX, y: ev.clientY },
      origRect: { ...cropDraft },
    };
    const onMove = (e) => {
      if (!cropDrag) return;
      const m = marks.find((x) => x.id === cropTargetId);
      if (!m) return;
      const dx = e.clientX - cropDrag.startMouse.x;
      const dy = e.clientY - cropDrag.startMouse.y;
      const o = cropDrag.origRect;
      const d = cropDrag.dir;
      const minSize = 12;
      let nx = o.x, ny = o.y, nw = o.w, nh = o.h;
      if (d.includes('e')) nw = Math.max(minSize, o.w + dx);
      if (d.includes('s')) nh = Math.max(minSize, o.h + dy);
      if (d.includes('w')) {
        nw = Math.max(minSize, o.w - dx);
        nx = o.x + (o.w - nw);
      }
      if (d.includes('n')) {
        nh = Math.max(minSize, o.h - dy);
        ny = o.y + (o.h - nh);
      }
      // clamp 在 mark 矩形内
      nx = Math.max(m.x, nx);
      ny = Math.max(m.y, ny);
      if (nx + nw > m.x + m.w) nw = (m.x + m.w) - nx;
      if (ny + nh > m.y + m.h) nh = (m.y + m.h) - ny;
      nw = Math.max(minSize, nw);
      nh = Math.max(minSize, nh);
      cropDraft = { x: nx, y: ny, w: nw, h: nh };
      renderMarks();
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      cropDrag = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
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

  // —— 拖拽缩放标记 ——
  // rect：保留单个右下角 handle（自由变形）
  // image：8 个 handle（4 角锁比例 + 4 边单向）
  let dragResize = null; // { mark, dir, startMouse, origMark }
  function startResize(ev, m, dir) {
    selectedMarkId = m.id;
    pushUndo();
    dragResize = {
      mark: m,
      dir: dir || 'se',
      startMouse: { x: ev.clientX, y: ev.clientY },
      origMark: JSON.parse(JSON.stringify(m)),
    };
    const onMove = (e) => {
      if (!dragResize) return;
      const dx = e.clientX - dragResize.startMouse.x;
      const dy = e.clientY - dragResize.startMouse.y;
      const o = dragResize.origMark;
      const t = dragResize.mark;
      const d = dragResize.dir;
      const minSize = 20;

      if (t.type === 'rect') {
        // rect 永远是右下角自由变形（兼容旧逻辑）
        t.w = Math.max(minSize, o.w + dx);
        t.h = Math.max(minSize, o.h + dy);
      } else if (t.type === 'image') {
        const ratio = o.w / o.h; // 锁比例用

        if (d === 'nw' || d === 'ne' || d === 'se' || d === 'sw') {
          // 角 handle：锁比例，按主导方向（dx/dy 谁的相对变化大）等比缩放
          const sx = dx / o.w;
          const sy = dy / o.h;
          // 对角线方向的拖动：dx/dy 同号才能放大；这里取相对值大的为主轴
          const s = Math.abs(sx) > Math.abs(sy) ? sx : sy;
          let newW = Math.max(minSize, o.w * (1 + s));
          let newH = Math.max(minSize, newW / ratio);
          if (d === 'se') {
            // anchor = 左上 (o.x, o.y)
            t.w = newW; t.h = newH;
          } else if (d === 'nw') {
            // anchor = 右下 (o.x+o.w, o.y+o.h)
            t.x = o.x + o.w - newW; t.y = o.y + o.h - newH; t.w = newW; t.h = newH;
          } else if (d === 'ne') {
            // anchor = 左下 (o.x, o.y+o.h)
            t.y = o.y + o.h - newH; t.w = newW; t.h = newH;
          } else if (d === 'sw') {
            // anchor = 右上 (o.x+o.w, o.y)
            t.x = o.x + o.w - newW; t.w = newW; t.h = newH;
          }
        } else {
          // 边 handle：单向拉伸（不锁比例）
          if (d === 'e') {
            t.w = Math.max(minSize, o.w + dx);
          } else if (d === 'w') {
            const newW = Math.max(minSize, o.w - dx);
            t.x = o.x + o.w - newW; t.w = newW;
          } else if (d === 's') {
            t.h = Math.max(minSize, o.h + dy);
          } else if (d === 'n') {
            const newH = Math.max(minSize, o.h - dy);
            t.y = o.y + o.h - newH; t.h = newH;
          }
        }
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

      // 有 crop 时用嵌套 svg：外层 svg 占据 (x,y,w,h)，viewBox 是裁剪比例区
      if (m.crop && m.crop.wr > 0 && m.crop.hr > 0) {
        const inner = document.createElementNS(ns, 'svg');
        inner.setAttribute('x', m.x);
        inner.setAttribute('y', m.y);
        inner.setAttribute('width', m.w);
        inner.setAttribute('height', m.h);
        // viewBox 用 0..1 区间，配 image 的 1×1 单位实现比例裁剪
        const vbX = (m.crop.xr || 0).toFixed(4);
        const vbY = (m.crop.yr || 0).toFixed(4);
        const vbW = m.crop.wr.toFixed(4);
        const vbH = m.crop.hr.toFixed(4);
        inner.setAttribute('viewBox', `${vbX} ${vbY} ${vbW} ${vbH}`);
        inner.setAttribute('preserveAspectRatio', 'none');
        const img = document.createElementNS(ns, 'image');
        img.setAttribute('x', 0);
        img.setAttribute('y', 0);
        img.setAttribute('width', 1);
        img.setAttribute('height', 1);
        img.setAttribute('preserveAspectRatio', 'none');
        img.setAttributeNS('http://www.w3.org/1999/xlink', 'href', m.src);
        img.setAttribute('href', m.src);
        inner.appendChild(img);
        g.appendChild(inner);
      } else {
        const img = document.createElementNS(ns, 'image');
        img.setAttribute('x', m.x);
        img.setAttribute('y', m.y);
        img.setAttribute('width', m.w);
        img.setAttribute('height', m.h);
        img.setAttribute('preserveAspectRatio', 'none');
        img.setAttributeNS('http://www.w3.org/1999/xlink', 'href', m.src);
        img.setAttribute('href', m.src);
        g.appendChild(img);
      }
      // 虚线边框便于辨识
      const border = document.createElementNS(ns, 'rect');
      border.setAttribute('x', m.x);
      border.setAttribute('y', m.y);
      border.setAttribute('width', m.w);
      border.setAttribute('height', m.h);
      border.setAttribute('fill', 'none');
      border.setAttribute('stroke', m.crop ? '#10b981' : '#3b82f6'); // 裁剪过用绿色提示
      border.setAttribute('stroke-width', '1');
      border.setAttribute('stroke-dasharray', '4 2');
      g.appendChild(border);

      // 裁剪过显示一个小标记（左上角）
      if (m.crop) {
        const tag = document.createElementNS(ns, 'g');
        const tagW = 28, tagH = 14;
        const tagBg = document.createElementNS(ns, 'rect');
        tagBg.setAttribute('x', m.x);
        tagBg.setAttribute('y', m.y - tagH - 2);
        tagBg.setAttribute('width', tagW);
        tagBg.setAttribute('height', tagH);
        tagBg.setAttribute('fill', '#10b981');
        tagBg.setAttribute('rx', 2);
        const tagTx = document.createElementNS(ns, 'text');
        tagTx.setAttribute('x', m.x + tagW / 2);
        tagTx.setAttribute('y', m.y - tagH / 2 + 4);
        tagTx.setAttribute('text-anchor', 'middle');
        tagTx.setAttribute('fill', '#fff');
        tagTx.setAttribute('font-size', '10');
        tagTx.textContent = '已裁剪';
        tag.appendChild(tagBg);
        tag.appendChild(tagTx);
        g.appendChild(tag);
      }

      // 裁剪模式期间隐藏 resize handle，由裁剪 overlay 接管
      if (cropTargetId === m.id) return g;

      // 8 个 resize handle（4 角锁比例 + 4 边单向）
      const hs = 9;
      const ew = 14, eh = 4;
      const cursorMap = {
        nw: 'nwse-resize', se: 'nwse-resize',
        ne: 'nesw-resize', sw: 'nesw-resize',
        n: 'ns-resize', s: 'ns-resize',
        e: 'ew-resize', w: 'ew-resize',
      };
      const handles = [
        ['nw', m.x,            m.y,            true],
        ['n',  m.x + m.w / 2,  m.y,            false],
        ['ne', m.x + m.w,      m.y,            true],
        ['e',  m.x + m.w,      m.y + m.h / 2,  false],
        ['se', m.x + m.w,      m.y + m.h,      true],
        ['s',  m.x + m.w / 2,  m.y + m.h,      false],
        ['sw', m.x,            m.y + m.h,      true],
        ['w',  m.x,            m.y + m.h / 2,  false],
      ];
      handles.forEach(([dir, cx, cy, isCorner]) => {
        const h = document.createElementNS(ns, 'rect');
        let w, hgt, x, y;
        if (isCorner) {
          w = hs; hgt = hs;
          x = cx - hs / 2; y = cy - hs / 2;
        } else if (dir === 'n' || dir === 's') {
          w = ew; hgt = eh;
          x = cx - ew / 2; y = cy - eh / 2;
        } else {
          w = eh; hgt = ew;
          x = cx - eh / 2; y = cy - ew / 2;
        }
        h.setAttribute('x', x);
        h.setAttribute('y', y);
        h.setAttribute('width', w);
        h.setAttribute('height', hgt);
        h.setAttribute('fill', '#3b82f6');
        h.setAttribute('stroke', '#fff');
        h.setAttribute('stroke-width', '1');
        h.setAttribute('rx', 1);
        h.style.cursor = cursorMap[dir];
        h.addEventListener('mousedown', (e) => {
          if (e.button !== 0) return;
          if (!markBoard.classList.contains('active')) return;
          e.stopPropagation();
          startResize(e, m, dir);
        });
        g.appendChild(h);
      });

      // 裁剪按钮（右上角小圆 + 剪刀图标）
      const btnR = 10;
      const btnCx = m.x + m.w - btnR - 2;
      const btnCy = m.y - btnR - 2;
      const cropBtn = document.createElementNS(ns, 'circle');
      cropBtn.setAttribute('cx', btnCx);
      cropBtn.setAttribute('cy', btnCy);
      cropBtn.setAttribute('r', btnR);
      cropBtn.setAttribute('fill', m.crop ? '#10b981' : '#3b82f6');
      cropBtn.setAttribute('stroke', '#fff');
      cropBtn.setAttribute('stroke-width', '1');
      cropBtn.style.cursor = 'pointer';
      const cropIco = document.createElementNS(ns, 'text');
      cropIco.setAttribute('x', btnCx);
      cropIco.setAttribute('y', btnCy + 4);
      cropIco.setAttribute('text-anchor', 'middle');
      cropIco.setAttribute('fill', '#fff');
      cropIco.setAttribute('font-size', '12');
      cropIco.style.pointerEvents = 'none';
      cropIco.textContent = '✂';
      cropBtn.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (!markBoard.classList.contains('active')) return;
        e.stopPropagation();
        e.preventDefault();
        enterCropMode(m.id);
      });
      g.appendChild(cropBtn);
      g.appendChild(cropIco);
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
    // 裁剪模式：Esc 取消，Enter / 回车确认
    if (cropTargetId) {
      if (ev.key === 'Escape') { ev.preventDefault(); exitCropMode(false); return; }
      if (ev.key === 'Enter') { ev.preventDefault(); exitCropMode(true); return; }
    }
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
