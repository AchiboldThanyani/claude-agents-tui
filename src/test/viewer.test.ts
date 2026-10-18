import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConversationFile, describeInput, parseConversation } from '../conversation';
import { layout, sanitize, Viewer, wrap } from '../viewer';
import { visibleLength } from '../render';

const plain = { color: false };
const T = '2026-10-18T12:00:00.000Z';
const jsonl = (...entries: object[]) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';

const prompt = (text: string) => ({ type: 'user', timestamp: T, message: { role: 'user', content: text } });
const reply = (text: string) => ({ type: 'assistant', timestamp: T, message: { content: [{ type: 'text', text }] } });
const toolUse = (name: string, input: object) => ({
  type: 'assistant',
  timestamp: T,
  message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'tool_use', id: 't', name, input }] },
});
const toolResult = (content: unknown, isError = false) => ({
  type: 'user',
  timestamp: T,
  message: { content: [{ type: 'tool_result', tool_use_id: 't', content, is_error: isError }] },
});

describe('parseConversation', () => {
  test('reads prompts, replies, tool calls and results in order', () => {
    const entries = parseConversation(
      jsonl(prompt('find the bug'), toolUse('Grep', { pattern: 'auth' }), toolResult('src/a.ts:3: auth()'), reply('Found it.')),
    );
    assert.deepEqual(
      entries.map((e) => [e.kind, e.tool ?? '', e.text]),
      [
        ['prompt', '', 'find the bug'],
        ['tool', 'Grep', 'pattern: auth'],
        ['result', '', 'src/a.ts:3: auth()'],
        ['reply', '', 'Found it.'],
      ],
    );
    assert.equal(entries[0].time, Date.parse(T));
  });

  test('marks failed tool results as errors', () => {
    const [e] = parseConversation(jsonl(toolResult('Exit code 1\nno such file', true)));
    assert.equal(e.kind, 'error');
    assert.equal(e.text, 'Exit code 1\nno such file');
  });

  test('handles results given as a list of parts', () => {
    const [e] = parseConversation(jsonl(toolResult([{ type: 'text', text: 'one' }, { type: 'image' }, { type: 'text', text: 'two' }])));
    assert.equal(e.text, 'one\n[image]\ntwo');
  });

  test('skips thinking, meta entries, system wrappers and broken lines', () => {
    const entries = parseConversation(
      jsonl(
        { ...prompt('hidden'), isMeta: true },
        prompt('<system-reminder>x</system-reminder>'),
        { type: 'attachment', attachment: {} },
        prompt('real'),
      ) + '{broken\n',
    );
    assert.deepEqual(entries.map((e) => e.text), ['real']);
  });

  test('turns an interrupt into its own entry', () => {
    const entries = parseConversation(
      jsonl({ type: 'user', timestamp: T, message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }),
    );
    assert.equal(entries[0].kind, 'interrupt');
  });

  test('describes tool input one field per line', () => {
    assert.equal(describeInput({ file_path: 'a.ts', limit: 20, flags: ['-n'] }), 'file_path: a.ts\nlimit: 20\nflags: ["-n"]');
  });
});

describe('text helpers', () => {
  test('wrap breaks at spaces and keeps blank lines', () => {
    assert.deepEqual(wrap('the quick brown fox\n\njumps', 10), ['the quick', 'brown fox', '', 'jumps']);
  });

  test('wrap hard-breaks words longer than the width', () => {
    assert.deepEqual(wrap('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
  });

  test('sanitize strips escape sequences and control characters from transcript text', () => {
    assert.equal(sanitize('a\x1b[31mred\x1b[0m\x1b]0;title\x07\tb\r\x00c'), 'ared  bc');
  });
});

describe('layout', () => {
  const entries = parseConversation(
    jsonl(
      prompt('find the bug'),
      toolUse('Bash', { command: 'npm test' }),
      toolResult(Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')),
      toolUse('Read', { file_path: 'x.ts' }),
      toolResult('ENOENT', true),
      reply('Done.'),
    ),
  );
  const lines = layout(entries, 60, plain);

  test('labels each kind of entry', () => {
    const text = lines.join('\n');
    for (const s of ['▸ Prompt', '⚙ Bash', 'command: npm test', '◆ Claude', 'Done.', '✗ failed', 'ENOENT']) {
      assert.ok(text.includes(s), `missing ${s}`);
    }
  });

  test('long tool output is cut with a count', () => {
    assert.ok(lines.some((l) => l.includes('line 8')));
    assert.ok(!lines.some((l) => l.includes('line 9')));
    assert.ok(lines.some((l) => l.includes('… 12 more lines')));
  });

  test('no line is wider than the width', () => {
    const long = layout(parseConversation(jsonl(reply('word '.repeat(200)))), 40, { color: true });
    for (const l of long) assert.ok(visibleLength(l) <= 40, `${visibleLength(l)}: ${l}`);
  });
});

describe('Viewer', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agents-viewer-'));
    file = path.join(dir, 'agent.jsonl');
    fs.writeFileSync(file, jsonl(...Array.from({ length: 30 }, (_, i) => reply(`reply ${i + 1}`))));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const make = () => new Viewer(new ConversationFile(file), 'Explore · Find code', '◎', '#5eead4');

  test('opens at the end and shows the title with a position', () => {
    const out = make().render(60, 10, plain);
    assert.equal(out.length, 10);
    assert.match(out[0], /◎ Explore · Find code .* \d+ lines · end/);
    assert.match(out[9], /reply 30/);
  });

  test('scrolls up, reports the position, and back to the end', () => {
    const v = make();
    v.render(60, 10, plain);
    v.scrollBy(-20, 10, 60, plain);
    assert.equal(v.follow, false);
    assert.match(v.render(60, 10, plain)[0], /\d+%/);
    v.toTop();
    assert.match(v.render(60, 10, plain)[1], /◆ Claude|reply 1/);
    v.toEnd();
    assert.match(v.render(60, 10, plain)[9], /reply 30/);
  });

  test('follows new activity at the end, but not while scrolled up', () => {
    const v = make();
    v.render(60, 10, plain);
    fs.appendFileSync(file, jsonl(reply('fresh')));
    assert.equal(v.conversation.refresh(), true);
    assert.match(v.render(60, 10, plain)[9], /fresh/);

    v.scrollBy(-5, 10, 60, plain);
    const before = v.render(60, 10, plain).join('\n');
    fs.appendFileSync(file, jsonl(reply('newer')));
    v.conversation.refresh();
    assert.equal(v.render(60, 10, plain).join('\n').replace(/\d+ lines · \d+%/, ''), before.replace(/\d+ lines · \d+%/, ''));
  });

  test('refresh is a no-op when the file has not changed', () => {
    const v = make();
    assert.equal(v.conversation.refresh(), false);
  });
});
