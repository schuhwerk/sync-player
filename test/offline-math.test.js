import { test, expect, describe } from 'bun:test';
import { underPrefix, collectPinItems, pinItemRecords } from '../src/offline-math.js';

describe('underPrefix', () => {
  test('root matches everything', () => {
    expect(underPrefix('/a', '/')).toBe(true);
    expect(underPrefix('/a/b/c', '/')).toBe(true);
    expect(underPrefix('/', '/')).toBe(true);
  });
  test('matches the prefix itself and nested paths', () => {
    expect(underPrefix('/foo', '/foo')).toBe(true);
    expect(underPrefix('/foo/bar', '/foo')).toBe(true);
  });
  test('respects the / boundary (no sibling-prefix leak)', () => {
    expect(underPrefix('/foobar', '/foo')).toBe(false);
    expect(underPrefix('/fo', '/foo')).toBe(false);
  });
});

describe('collectPinItems', () => {
  const tree = {
    '/foo': { files: [{ path: '/foo/a.wav' }], attachments: [{ path: '/foo/n.pdf' }] },
    '/foo/sub': { files: [{ path: '/foo/sub/b.wav' }] },
    '/foobar': { files: [{ path: '/foobar/c.wav' }] }, // sibling, must be excluded
    '/other': { files: [{ path: '/other/d.wav' }] },
  };
  test('returns [] for a falsy tree', () => {
    expect(collectPinItems(null, '/foo')).toEqual([]);
  });
  test('flattens files + attachments under the prefix only', () => {
    const paths = collectPinItems(tree, '/foo').map(f => f.path);
    expect(paths).toEqual(['/foo/a.wav', '/foo/n.pdf', '/foo/sub/b.wav']);
  });
  test('root prefix gathers the whole tree', () => {
    expect(collectPinItems(tree, '/').length).toBe(5);
  });
  test('tolerates entries missing files/attachments', () => {
    expect(collectPinItems({ '/x': {} }, '/x')).toEqual([]);
  });
});

describe('pinItemRecords', () => {
  test('keeps path/lm/name and defaults kind to audio', () => {
    expect(pinItemRecords([{ path: '/a.wav', lm: '111', name: 'a.wav' }]))
      .toEqual([{ path: '/a.wav', lm: '111', name: 'a.wav', kind: 'audio' }]);
  });
  test('preserves a non-audio kind', () => {
    expect(pinItemRecords([{ path: '/n.pdf', lm: '1', name: 'n.pdf', kind: 'attachment' }])[0].kind)
      .toBe('attachment');
  });
});
