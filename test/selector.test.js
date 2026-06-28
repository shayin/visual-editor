import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { computeSelector, isSemanticClass, escapeId } from '../lib/selector-computer.js';

// 简易 jsdom 测试环境（测试时安装 jsdom）
// 如果 jsdom 没装则跳过这组测试
let dom;
try {
  const { JSDOM: J } = await import('jsdom');
  dom = new J('<!DOCTYPE html><html><body></body></html>');
} catch {
  console.warn('jsdom 未安装，DOM 相关测试跳过');
}

function makeDom(html) {
  const d = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`);
  return d.window.document;
}

test('isSemanticClass: 识别 ppt-shape-library 的语义 class', () => {
  assert.ok(isSemanticClass('slot-title'));
  assert.ok(isSemanticClass('funnel'));
  assert.ok(isSemanticClass('shape'));
  assert.ok(isSemanticClass('stage'));
  assert.ok(!isSemanticClass('hover'));
  assert.ok(!isSemanticClass('active'));
  assert.ok(!isSemanticClass(''));
});

test('escapeId: 转义特殊字符', () => {
  assert.equal(escapeId('foo_bar'), 'foo_bar');
  assert.equal(escapeId('a.b'), 'a\\.b');
});

test('优先级 1: data-ai-id 直接返回属性选择器', () => {
  const doc = makeDom('<div data-ai-id="hero.title">星辰</div>');
  const el = doc.querySelector('[data-ai-id]');
  const r = computeSelector(el);
  assert.equal(r.css, '[data-ai-id="hero.title"]');
  assert.equal(r.anchor, 'data-ai-id');
});

test('优先级 2: id 返回 #id', () => {
  const doc = makeDom('<div id="main"><p id="lead">x</p></div>');
  const el = doc.getElementById('lead');
  const r = computeSelector(el);
  assert.equal(r.css, '#lead');
  assert.equal(r.anchor, 'id');
});

test('优先级 3: data-slot + class 组合', () => {
  const doc = makeDom(`
    <div class="slide">
      <div class="body">
        <div class="slot slot-left" data-slot="left">
          <div class="slot-title">能力</div>
        </div>
      </div>
    </div>
  `);
  const title = doc.querySelector('.slot-title');
  const r = computeSelector(title);
  // 期望至少命中 slot 锚点 + slot-title class
  assert.match(r.css, /\[data-slot="left"\]/);
  assert.match(r.css, /\.slot-title/);
});

test('同级多个相同 class 时用 nth-child 区分', () => {
  const doc = makeDom(`
    <div class="funnel">
      <div class="stage">A</div>
      <div class="stage">B</div>
      <div class="stage">C</div>
    </div>
  `);
  const stages = doc.querySelectorAll('.stage');
  const r2 = computeSelector(stages[1]);
  assert.match(r2.css, /\.stage:nth-child\(2\)/);

  const r3 = computeSelector(stages[2]);
  assert.match(r3.css, /\.stage:nth-child\(3\)/);
});

test('回退到 tag + nth-child（无 class 时）', () => {
  const doc = makeDom('<div><span>a</span><span>b</span></div>');
  const spans = doc.querySelectorAll('span');
  const r = computeSelector(spans[1]);
  assert.match(r.css, /span:nth-child\(2\)/);
});

test('链路在遇到 data-slot 父节点时停止向上', () => {
  const doc = makeDom(`
    <div class="slide">
      <div class="body">
        <div class="slot" data-slot="left">
          <div class="slot-body">
            <div class="funnel"><div class="stage">x</div></div>
          </div>
        </div>
      </div>
    </div>
  `);
  const stage = doc.querySelector('.stage');
  const r = computeSelector(stage);
  // chain 应该在 [data-slot="left"] 处停止向上
  assert.ok(r.css.includes('[data-slot="left"]'), `css: ${r.css}`);
  assert.ok(!r.css.includes('.slide'), `不应再向上到 .slide: ${r.css}`);
});
