/**
 * The runtime's one decision that does not need a document.
 *
 * `dc.js` applies bindings to elements, and almost all of it needs a DOM the
 * suite does not have — `vitest.config.ts` runs in `node` and neither jsdom nor
 * happy-dom is a dependency here. **That limitation is declared rather than
 * worked around**: the rest of `dc.js` has no test, and adding a DOM to this
 * repository is a decision about dependencies, not a detail of this file.
 *
 * What IS covered is the part that actually broke, and it is covered because it
 * was written to be coverable: `giveRef` takes the element as an opaque value,
 * so the whole disagreement between the page and the component can be exercised
 * with plain objects.
 */

import { describe, it, expect } from 'vitest';
import { giveRef, createRef, propertiesIn } from './dc.js';

describe('a ref reaches the component whatever shape it declared', () => {
    it('calls a ref that is a function', () => {
        // The bug this covers: the prototype declares its refs as callbacks,
        // the way React does, and the runtime only ever assigned a field. The
        // callbacks were never invoked, so `this._input`, `this._file`,
        // `this._menu` and `this._scroller` stayed undefined for the life of
        // the page and every feature reading them silently did nothing.
        /** @type {unknown[]} */
        const seen = [];
        const el = { tag: 'textarea' };
        const shape = giveRef((/** @type {unknown} */ node) => seen.push(node), el, {}, 'groundRef');

        expect(shape).toBe('callback');
        expect(seen).toEqual([el]);
    });

    it('fills a ref that is a `createRef` object', () => {
        const ref = createRef();
        const el = { tag: 'aside' };
        const shape = giveRef(ref, el, {}, 'paneRef');

        expect(shape).toBe('object');
        expect(ref.current).toBe(el);
    });

    it('falls back to a field on the component when nothing was declared', () => {
        // The shape this runtime documents, kept for a page that declares no
        // ref of its own.
        /** @type {Record<string, unknown>} */
        const component = {};
        const el = { tag: 'div' };
        const shape = giveRef(undefined, el, component, 'whateverRef');

        expect(shape).toBe('field');
        expect(component.whateverRef).toEqual({ current: el });
    });

    it('does not mistake a function for an object with a `current`', () => {
        // A callback ref carrying a property would take the object branch on a
        // check written in the other order, and the element would land on the
        // function instead of being passed to it.
        /** @type {unknown[]} */
        const seen = [];
        /** @type {{ (node: unknown): number, current: unknown }} */
        const withProperty = Object.assign((/** @type {unknown} */ node) => seen.push(node), { current: /** @type {unknown} */ (null) });

        expect(giveRef(withProperty, { tag: 'p' }, {}, 'oddRef')).toBe('callback');
        expect(seen).toHaveLength(1);
        expect(withProperty.current).toBeNull();
    });
});

describe('a hover knows which properties to put back', () => {
    it('names the property of a single rule', () => {
        expect(propertiesIn('color: #fff')).toEqual(['color']);
    });

    it('is not confused by a colon inside a value', () => {
        // The realistic shape in this markup: a shadow whose value carries
        // both commas and parentheses, and a colour function beside it.
        expect(propertiesIn('box-shadow: 0 0 20px rgba(126,207,128,0.35); color: #fff')).toEqual([
            'box-shadow',
            'color',
        ]);
    });

    it('ignores a trailing semicolon and an empty rule', () => {
        expect(propertiesIn('border-color: #1A1A1F;;')).toEqual(['border-color']);
    });

    it('returns nothing for nothing', () => {
        // The control: a splitter that returned `['']` here would try to
        // remove a property with no name on every pointerleave.
        expect(propertiesIn('')).toEqual([]);
        expect(propertiesIn('   ')).toEqual([]);
    });
});
