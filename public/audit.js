// audit.js — HTML 健康度体检 + 触发 AI 修复
// 检测：伪元素（::before/::after）+ 缺 data-ai-id 的语义元素
// 修复：不直接改文件，构造 prompt 灌进 Claude 终端让 AI 改（含备份要求）

(function () {
  // 依赖从 app.js 暴露的全局：sendWs / toast / state.currentFile / term
  const $ = (s) => document.querySelector(s);

  const SKIP_CLASSES = new Set([
    'ppt-ve-hover', 'ppt-ve-selected', 'ppt-ve-tag', 'ppt-ve-pseudo-hl',
  ]);
  const VOID_TAGS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr',
  ]);
  const NO_INJECT_TAGS = new Set([
    'script', 'style', 'head', 'meta', 'link', 'title', 'html', 'body',
  ]);

  // 拿到 iframe 的 contentDocument
  function getIframeDoc() {
    const f = $('#previewIframe');
    if (!f || !f.contentDocument) return null;
    return f.contentDocument;
  }

  // —— 体检：伪元素 ——
  // 扫描所有 <style> 内联样式 + inline style，
  // 找出 ::before / ::after 且 content 非空的规则
  function scanPseudoElements(doc) {
    const found = [];
    doc.querySelectorAll('style').forEach((styleEl) => {
      const css = styleEl.textContent || '';
      // 简化匹配：selector::before { ... } / selector::after { ... }
      // 不处理逗号分组、@media 嵌套（外部 CSS 也跳过）
      const re = /([^{};]+?(?:::(?:before|after))\s*(?:,\s*[^{};]+?(?:::(?:before|after))\s*)*)\{([^{}]*)\}/g;
      let m;
      while ((m = re.exec(css)) !== null) {
        const selectorsRaw = m[1];
        const body = m[2];
        // 解析 content
        const cm = body.match(/content\s*:\s*(['"])(.*?)\1/);
        const content = cm ? cm[2] : null;
        const contentEmpty = !cm || cm[2] === '';
        // 切分多个 selector
        const selectors = selectorsRaw.split(',').map((s) => s.trim()).filter(Boolean);
        for (const sel of selectors) {
          // 提取宿主选择器（去掉伪元素部分）
          const hostMatch = sel.match(/^(.*?)::(?:before|after)$/);
          if (!hostMatch) continue;
          const hostSel = hostMatch[1].trim();
          const pseudo = sel.endsWith('::before') ? '::before' : '::after';
          // 统计实际命中元素
          let hits = 0;
          if (hostSel) {
            try { hits = doc.querySelectorAll(hostSel).length; } catch {}
          }
          found.push({
            selector: sel,
            hostSelector: hostSel || '(global)',
            pseudo,
            content,
            contentEmpty,
            hits,
          });
        }
      }
    });
    return found;
  }

  // —— 体检：缺 data-ai-id 的语义元素 ——
  function scanMissingAiids(doc) {
    const missing = [];
    doc.querySelectorAll('*').forEach((el) => {
      const tag = el.tagName.toLowerCase();
      if (VOID_TAGS.has(tag) || NO_INJECT_TAGS.has(tag)) return;
      if (el.getAttribute('data-ai-id')) return;
      // 必须有 id / data-slot / 至少一个非 skip 的 class
      const id = el.getAttribute('id');
      const slot = el.getAttribute('data-slot');
      const segs = Array.from(el.classList || []).filter(
        (c) => c && !SKIP_CLASSES.has(c) && !c.startsWith('ppt-ve-')
      );
      if (!id && !slot && segs.length === 0) return;
      missing.push({
        tag,
        classes: segs,
        id,
        slot,
        // 简短预览
        preview: shortPreview(el),
      });
    });
    return missing;
  }

  function shortPreview(el) {
    const txt = (el.textContent || '').trim().slice(0, 24);
    if (txt) return txt;
    const tag = el.tagName.toLowerCase();
    const cls = Array.from(el.classList || []).filter((c) => !c.startsWith('ppt-ve-')).slice(0, 2).join('.');
    return `<${tag}${cls ? '.' + cls : ''}>`;
  }

  // —— 完整体检 ——
  async function runAudit() {
    const doc = getIframeDoc();
    if (!doc) {
      window.toast?.({ type: 'error', title: '体检失败', msg: 'iframe 未加载' });
      return null;
    }
    const pseudo = scanPseudoElements(doc);
    const missing = scanMissingAiids(doc);
    // 过滤掉命中数为 0 的伪元素规则（装饰但已没生效）
    const pseudoActive = pseudo.filter((p) => p.hits > 0);
    const report = {
      pseudo: pseudoActive,
      missing,
      ts: Date.now(),
    };
    renderReport(report);
    return report;
  }

  // —— 报告渲染 ——
  function renderReport(r) {
    const modal = $('#auditModal');
    if (!modal) return;
    const pCount = r.pseudo.length;
    const mCount = r.missing.length;

    // 头部总览
    const summary = $('#auditSummary');
    if (pCount === 0 && mCount === 0) {
      summary.innerHTML = `<span class="audit-ok">✓ HTML 定位友好：无伪元素、所有语义元素都有 data-ai-id</span>`;
    } else {
      const bits = [];
      if (pCount) bits.push(`<span class="audit-warn">⚠ ${pCount} 个伪元素规则命中 DOM</span>`);
      if (mCount) bits.push(`<span class="audit-warn">⚠ ${mCount} 个语义元素缺 data-ai-id</span>`);
      summary.innerHTML = bits.join('<br>');
    }

    // 伪元素列表
    const pseudoList = $('#auditPseudoList');
    if (pCount === 0) {
      pseudoList.innerHTML = `<div class="audit-empty">无伪元素</div>`;
    } else {
      pseudoList.innerHTML = r.pseudo.map((p, i) => `
        <div class="audit-item">
          <div class="audit-item-head">
            <code>${escapeHtml(p.selector)}</code>
            <span class="audit-hits">${p.hits} 处</span>
          </div>
          <div class="audit-item-meta">
            content: ${p.content === null ? '<i>未设</i>' : p.contentEmpty ? '<i>空（装饰图形）</i>' : `<code>${escapeHtml(p.content)}</code>`}
          </div>
        </div>
      `).join('');
    }

    // 缺 aiiD 列表（最多 30 条）
    const missingList = $('#auditMissingList');
    if (mCount === 0) {
      missingList.innerHTML = `<div class="audit-empty">所有语义元素都有 aiiD</div>`;
    } else {
      const shown = r.missing.slice(0, 30);
      missingList.innerHTML = shown.map((m) => `
        <div class="audit-item">
          <div class="audit-item-head">
            <code>${escapeHtml(m.tag)}${m.classes.length ? '.' + escapeHtml(m.classes.join('.')) : ''}</code>
            ${m.id ? `<span class="audit-hits">#${escapeHtml(m.id)}</span>` : ''}
          </div>
          <div class="audit-item-meta">${escapeHtml(m.preview)}</div>
        </div>
      `).join('') + (mCount > 30 ? `<div class="audit-more">…还有 ${mCount - 30} 个</div>` : '');
    }

    // 按钮启用状态
    $('#auditFixPseudoBtn').disabled = pCount === 0;
    $('#auditFixAiidBtn').disabled = mCount === 0;

    // 更新 topbar 按钮徽章
    updateBadge(pCount, mCount);
  }

  function updateBadge(pCount, mCount) {
    const btn = $('#auditBtn');
    if (!btn) return;
    const total = pCount + mCount;
    // 清掉旧 badge
    btn.querySelectorAll('.audit-badge').forEach((b) => b.remove());
    if (total > 0) {
      const badge = document.createElement('span');
      badge.className = 'audit-badge';
      badge.textContent = String(total);
      btn.appendChild(badge);
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // —— 触发 AI 修复 ——
  // 构造 prompt，通过 pty:in 灌进终端，让 Claude 来改（强调先备份）
  function sendPromptToTerminal(text) {
    const data = text + '\n';
    window.sendWs?.({ type: 'pty:in', data });
    window.term?.focus?.();
  }

  function fixPseudo() {
    const file = window.state?.currentFile;
    if (!file) {
      window.toast?.({ type: 'error', msg: '未加载文件' });
      return;
    }
    const report = lastReport;
    if (!report || report.pseudo.length === 0) return;

    const rules = report.pseudo.map((p, i) =>
      `${i + 1}. ${p.selector} | 命中 ${p.hits} | content: ${p.content === null ? '未设' : `"${p.content}"`}`
    ).join('\n');

    const prompt = `修复 HTML 伪元素，文件：${file}

铁律：
1. 先备份：\`curl -sX POST http://localhost:${location.port}/api/backup -H 'Content-Type: application/json' -d '{"file":"${file.replace(/'/g, "\\'")}"}'\`（自动滚动保留 N 份）
2. ::before prepend / ::after append 一个 <span class="语义名">CONTENT</span>（如 arrow/dash/bullet/icon，禁用 pe-1）
3. CSS 把 \`X::before/after\` 改成 \`X .新class\`，删 content，其余保留
4. content 空（纯装饰）→ span 不放文本；content 含 attr()/counter() → 跳过并说明
5. :last-child 等条件选择器 → \` :last-child .新class\`

规则清单：
${rules}

逐条改完汇报，确认无残留。`;

    sendPromptToTerminal(prompt);
    window.toast?.({ type: 'success', title: '已发送到终端', msg: '让 AI 备份后修复伪元素', duration: 2500 });
  }

  function fixAiids() {
    const file = window.state?.currentFile;
    if (!file) {
      window.toast?.({ type: 'error', msg: '未加载文件' });
      return;
    }
    const report = lastReport;
    if (!report || report.missing.length === 0) return;

    const items = report.missing.slice(0, 30).map((m, i) => {
      const loc = [m.tag, m.classes.length ? m.classes[0] : '', m.id ? '#' + m.id : '', m.slot ? '[slot=' + m.slot + ']' : '']
        .filter(Boolean).join('');
      return `${i + 1}. ${loc} | ${m.preview}`;
    }).join('\n');
    const tail = report.missing.length > 30 ? `\n…还有 ${report.missing.length - 30} 个，遍历 DOM 全部补齐` : '';

    const prompt = `补 data-ai-id 锚点，文件：${file}

铁律：
1. 先备份：\`curl -sX POST http://localhost:${location.port}/api/backup -H 'Content-Type: application/json' -d '{"file":"${file.replace(/'/g, "\\'")}"}'\`
2. 命名：父链 class 路径 + 自身 class（如 shape.stepper.step.dot）；全局唯一，同级同 class 加序号 step/step[2]/step[3]，重名都加
3. 优先级：id > data-slot > 首个语义 class；纯装饰（无 id/class/slot）跳过
4. 已有 data-ai-id 不动；只补属性，不改 CSS/结构

待补元素：
${items}${tail}

补完扫一遍重名，汇报新增数量。`;

    sendPromptToTerminal(prompt);
    window.toast?.({ type: 'success', title: '已发送到终端', msg: '让 AI 备份后补 aiiD', duration: 2500 });
  }

  let lastReport = null;

  // 暴露给外部
  window.audit = {
    run: runAudit,
    fixPseudo,
    fixAiids,
    get lastReport() { return lastReport; },
    set lastReport(v) { lastReport = v; },
  };

  // DOM ready 后绑定事件
  function bind() {
    const auditBtn = $('#auditBtn');
    const auditModal = $('#auditModal');
    const auditClose = $('#auditClose');
    const rerunBtn = $('#auditRerunBtn');
    const fixPseudoBtn = $('#auditFixPseudoBtn');
    const fixAiidBtn = $('#auditFixAiidBtn');

    if (auditBtn) auditBtn.addEventListener('click', async () => {
      auditModal.classList.add('open');
      lastReport = await runAudit();
    });
    if (auditClose) auditClose.addEventListener('click', () => auditModal.classList.remove('open'));
    if (rerunBtn) rerunBtn.addEventListener('click', async () => { lastReport = await runAudit(); });
    if (fixPseudoBtn) fixPseudoBtn.addEventListener('click', fixPseudo);
    if (fixAiidBtn) fixAiidBtn.addEventListener('click', fixAiids);

    // 点 backdrop 关闭
    if (auditModal) auditModal.addEventListener('click', (e) => {
      if (e.target === auditModal) auditModal.classList.remove('open');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }

  // 监听 iframe 刷新 → 自动重新体检（如果面板是打开的）
  // 通过 MutationObserver 监听 previewWrap 的 iframe 替换
  const previewWrap = document.getElementById('previewWrap');
  if (previewWrap) {
    const observer = new MutationObserver(() => {
      const modal = document.getElementById('auditModal');
      if (modal && modal.classList.contains('open')) {
        // iframe 重新加载，等一会儿再扫
        setTimeout(() => { runAudit().then((r) => { lastReport = r; }); }, 800);
      } else {
        // 即使面板没开，也悄悄跑一次体检，更新 badge
        setTimeout(() => {
          const doc = getIframeDoc();
          if (!doc) return;
          const pseudo = scanPseudoElements(doc).filter((p) => p.hits > 0);
          const missing = scanMissingAiids(doc);
          updateBadge(pseudo.length, missing.length);
        }, 800);
      }
    });
    observer.observe(previewWrap, { childList: true, subtree: false });
  }
})();
