// selector-computer.js
// 三层回退的元素定位算法：
// 优先级 1: data-ai-id          →  [data-ai-id="xxx"]
// 优先级 2: data-slot / id      →  #myid 或 .slot[data-slot="left"] .slot-title
// 优先级 3: 语义 class 链        →  .slide > .body > .funnel .stage:nth-child(2)
// 优先级 4: 文本锚点             →  通过 textContent 反查（在调用方处理）

// 判断元素是否有用户语义（非工具/随机生成的 class）
const SEMANTIC_CLASS = /^(slide|header|body|foot|footer|slot|slot-title|slot-body|kicker|title|subtitle|shape|shape-title|funnel|stage|tree|node|timeline|stat|card|grid|item|badge|tag|btn|button|icon|container|row|col|cell|nav|menu|link)$/i;
const IGNORE_CLASS = /^(hover|active|focus|hidden|visible|disabled|selected|hl|highlight|overlay-\w+)$/i;

function isSemanticClass(cls) {
  if (!cls) return false;
  if (IGNORE_CLASS.test(cls)) return false;
  // 形如 slot-title 这种带连字符的语义名直接放行
  if (/[a-z]+-[a-z]+/.test(cls) && !/^(text|bg|border|padding|margin|font|size|w|h|p|m)-/.test(cls)) {
    return true;
  }
  return SEMANTIC_CLASS.test(cls);
}

function escapeId(id) {
  if (!id) return null;
  // CSS 标识符转义
  return id.replace(/[^a-zA-Z0-9_-]/g, (ch) => '\\' + ch);
}

function escapeAttr(val) {
  return val.replace(/"/g, '\\"');
}

function computeSelectorChain(el, root = null) {
  const chain = [];
  let cur = el;
  let depth = 0;
  const MAX_DEPTH = 6;

  while (cur && cur.nodeType === 1 && cur !== root && depth < MAX_DEPTH) {
    const seg = describeSegment(cur, cur.parentElement);
    chain.unshift(seg);
    // 当前段已是强锚点（id / data-ai-id / data-slot），停止向上
    if (seg.anchor === 'data-ai-id' || seg.anchor === 'id' || seg.anchor === 'data-slot') {
      break;
    }
    cur = cur.parentElement;
    depth++;
  }
  return chain;
}

function getAttr(el, name) {
  return el && el.getAttribute ? el.getAttribute(name) : null;
}

function describeSegment(el, parent) {
  // 1. data-ai-id 最高优先
  const aiId = getAttr(el, 'data-ai-id');
  if (aiId) {
    return { type: 'attr', sel: `[data-ai-id="${escapeAttr(aiId)}"]`, anchor: 'data-ai-id' };
  }
  // 2. id（但 framework 生成的随机 id 跳过）
  if (el.id && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(el.id) && !/^(:|react|ember|vue|__)/.test(el.id)) {
    return { type: 'id', sel: `#${escapeId(el.id)}`, anchor: 'id' };
  }
  // 3. data-slot
  const slot = getAttr(el, 'data-slot');
  if (slot) {
    return { type: 'attr', sel: `[data-slot="${escapeAttr(slot)}"]`, anchor: 'data-slot' };
  }

  const tag = el.tagName.toLowerCase();
  const classList = Array.from(el.classList || []).filter(isSemanticClass);

  // 4. 语义 class 组合（最多取 2 个避免过长）
  if (classList.length > 0) {
    const picked = classList.slice(0, 2).map((c) => `.${c}`).join('');
    let sel = picked;
    // 同级同 class 的兄弟节点用 nth-child 区分
    if (parent) {
      const sameClassSiblings = Array.from(parent.children).filter((s) =>
        s !== el && classList.every((c) => s.classList.contains(c))
      );
      if (sameClassSiblings.length > 0) {
        const index = Array.from(parent.children).indexOf(el) + 1;
        sel = `${picked}:nth-child(${index})`;
      }
    }
    return { type: 'class', sel, tag, anchor: 'class' };
  }

  // 5. 回退到 tag + nth-child
  let sel = tag;
  if (parent) {
    const index = Array.from(parent.children).indexOf(el) + 1;
    sel = `${tag}:nth-child(${index})`;
  }
  return { type: 'tag', sel, tag, anchor: 'tag' };
}

function chainToCssSelector(chain, root = null) {
  // 找到最强的锚点，从锚点开始拼接到目标
  // 简化处理：整条链都用后代选择器连接（空格），最后一个 nth-child 已在段内处理
  let parts = chain.map((s) => s.sel);
  let css = parts.join(' ');
  // 去掉冗余：如果中间某段是 tag 但前面已有锚点段，跳过中间 tag
  // （实现可后续优化）
  return css;
}

// 主入口
function computeSelector(el, root = null) {
  if (!el || el.nodeType !== 1) return null;
  const chain = computeSelectorChain(el, root);
  const css = chainToCssSelector(chain, root);
  return {
    css,
    chain,
    anchor: chain[0] ? chain[0].anchor : null,
  };
}

// 给定一个文本片段，返回包含该文本的最小元素选择器（文本锚点）
function textAnchorSelector(root, text) {
  if (!root || !text) return null;
  const txp = `//*[contains(normalize-space(text()), ${JSON.stringify(text)})]`;
  // 在浏览器内用 TreeWalker 实现；这里返回描述符由调用方处理
  return { type: 'text', text, xpath: txp };
}

export { computeSelector, computeSelectorChain, isSemanticClass, escapeId, escapeAttr, textAnchorSelector };
