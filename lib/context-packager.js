// context-packager.js
// 把一次选区（用户点击的元素）组装成 AI 能精准理解的上下文包

export function packageContext({ selector, elementHtml, siblings = [], rect = null, note = '' }) {
  const lines = [];
  const attrs = [];
  if (selector?.anchor) attrs.push(`anchor="${selector.anchor}"`);
  if (selector?.css) attrs.push(`selector=${JSON.stringify(selector.css)}`);
  lines.push(`<target ${attrs.join(' ')}>`);
  if (elementHtml) {
    lines.push('<element>');
    lines.push(indent(truncate(elementHtml, 800)));
    lines.push('</element>');
  }
  if (siblings.length > 0) {
    lines.push('<context>');
    for (const s of siblings) {
      lines.push(`  ${s.relation}: ${truncate(s.html, 200)}`);
    }
    lines.push('</context>');
  }
  if (rect) {
    lines.push(`<rect x="${rect.x}" y="${rect.y}" w="${rect.w}" h="${rect.h}" />`);
  }
  if (note) {
    lines.push(`<note>${note}</note>`);
  }
  lines.push('</target>');
  return lines.join('\n');
}

function truncate(s, max) {
  if (!s) return s;
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + ' …' : s;
}

function indent(s, n = 2) {
  const pad = ' '.repeat(n);
  return s.split('\n').map((l) => pad + l).join('\n');
}

// 用于把上下文包以"反引号块"形式插入 Claude 终端
// 让 Claude 知道这是一段引用的上下文而非用户指令
export function wrapForTerminalInjection(contextPacket) {
  return '\n```\n' + contextPacket + '\n```\n';
}
