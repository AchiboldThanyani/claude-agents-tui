import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { isMouseInput, MOUSE_OFF, MOUSE_ON, parseMouse } from '../input';

describe('parseMouse', () => {
  test('left press becomes a 0-based click; the release is ignored', () => {
    assert.deepEqual(parseMouse('\x1b[<0;10;5M\x1b[<0;10;5m'), [{ kind: 'click', x: 9, y: 4 }]);
  });

  test('wheel up and down', () => {
    assert.deepEqual(parseMouse('\x1b[<64;3;4M\x1b[<65;3;4M'), [
      { kind: 'wheel', dir: 'up', x: 2, y: 3 },
      { kind: 'wheel', dir: 'down', x: 2, y: 3 },
    ]);
  });

  test('right/middle buttons and drags are ignored', () => {
    assert.deepEqual(parseMouse('\x1b[<1;1;1M\x1b[<2;1;1M\x1b[<32;5;5M'), []);
  });

  test('modifier keys still count as a click', () => {
    assert.deepEqual(parseMouse('\x1b[<16;2;2M'), [{ kind: 'click', x: 1, y: 1 }]); // ctrl+click
  });

  test('ordinary keys are not mouse input', () => {
    assert.equal(isMouseInput('\x1b[A'), false);
    assert.equal(isMouseInput('q'), false);
    assert.equal(isMouseInput('\x1b[<0;1;1M'), true);
    assert.deepEqual(parseMouse('\x1b[A'), []);
  });

  test('turns SGR click reporting on and off', () => {
    assert.equal(MOUSE_ON, '\x1b[?1000h\x1b[?1006h');
    assert.equal(MOUSE_OFF, '\x1b[?1000l\x1b[?1006l');
  });
});
