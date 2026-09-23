/**
 * The small runtime the prototype's markup needs, so the markup itself did
 * not have to change.
 *
 * The prototype was authored against an artifact runtime that compiled its
 * `{{ }}` bindings into React. That runtime is generated, unlicensed code and
 * cannot be redistributed, and the React it expected would be a second thing
 * to ship. So the bindings became `data-*` attributes — a mechanical rewrite,
 * one attribute per binding — and this file applies a plain object to them.
 *
 * What it supports is only what that markup uses:
 *
 *     data-if="flag"            shown while the value is truthy
 *     data-for="list"           a <template> cloned once per item, with
 *     data-as="item"            `item.field` readable inside it
 *     data-text="path"          textContent
 *     data-style="path"         a React-shaped style object
 *     data-attr-NAME="path"     any other attribute
 *     data-on-EVENT="path"      a listener, bound once
 *     data-ref="name"           the element, handed to whatever shape the
 *                               component declared under that name
 *     style-hover="css"         literal CSS applied while the pointer is on it
 *
 * It is not a framework and must not grow into one. Every feature here exists
 * because one attribute in `index.html` uses it; anything else belongs in the
 * page, not in a layer under it.
 */

/** @returns {{ current: Element | null }} */
export function createRef() {
    return { current: null };
}

/**
 * Hands one element to whatever shape of ref the component declared.
 *
 * **Three shapes, because the page is two files that disagreed.** This runtime
 * was written to write `component.name.current` and the prototype was written
 * against React, where a ref can also be a function the library calls. Nothing
 * reconciled the two: the callbacks sat in `renderVals` and were never invoked,
 * so five features stopped happening at once — the divider stopped resizing,
 * "Send a file" stopped opening the picker, the composer stopped clearing after
 * a send, the new block stopped scrolling into view, and the attach menu
 * stopped closing on an outside click. None of them raised anything: every
 * reader guards with `?.` or an `if`, so a dead ref is a feature that quietly
 * declines to exist.
 *
 * It takes no DOM, on purpose: the element is whatever the caller has, so this
 * decision is testable without a document, which is the part that failed.
 *
 * @param {unknown} declared what the component published under that name
 * @param {unknown} el the element to hand over
 * @param {Record<string, unknown>} component the component itself, for the fallback
 * @param {string} name the name the page used
 * @returns {'callback' | 'object' | 'field'} which shape was used
 */
export function giveRef(declared, el, component, name) {
    if (typeof declared === 'function') {
        declared(el);
        return 'callback';
    }
    if (declared !== null && typeof declared === 'object' && 'current' in declared) {
        /** @type {{ current: unknown }} */ (declared).current = el;
        return 'object';
    }
    component[name] = { current: el };
    return 'field';
}

/**
 * The property names a block of CSS declares, in order.
 *
 * Used to undo a hover: the properties it set are the ones to put back. It
 * takes no DOM so the arithmetic is testable, and the arithmetic is the part
 * with an edge — a trailing semicolon, a colon inside a value like
 * `rgba(0,0,0,0.5)`, an empty rule between two others.
 *
 * @param {string} css
 * @returns {string[]}
 */
export function propertiesIn(css) {
    return css
        .split(';')
        .map((rule) => (rule.split(':')[0] ?? '').trim())
        .filter((name) => name !== '');
}

/**
 * The elements the pointer is on right now, with the hover they are wearing.
 *
 * **A hover and a render both write the same inline declarations**, and one of
 * them arrives while the other is in effect. Clicking a control the pointer is
 * resting on — the gear, the pane button, copy — re-renders it, `data-style`
 * rewrites the whole `cssText`, and the value captured on the way in is now the
 * value from BEFORE the click. Putting it back on `pointerleave` then paints
 * over what the render had just decided: the gear went dark while its drawer
 * was open, and stayed dark until something else re-rendered it.
 *
 * So the capture is refreshed by the render rather than taken once: while an
 * element is in here, `put` recaptures what the new style declares and lays the
 * hover back on top, which keeps "what the element declares underneath"
 * true at every moment rather than only at the moment the pointer arrived.
 *
 * @type {WeakMap<HTMLElement, { css: string, names: string[], before: Record<string, string> }>}
 */
const hovering = new WeakMap();

/**
 * @param {HTMLElement} node
 * @param {readonly string[]} names
 * @returns {Record<string, string>}
 */
function declaredNow(node, names) {
    /** @type {Record<string, string>} */
    const own = {};
    for (const name of names) own[name] = node.style.getPropertyValue(name);
    return own;
}

/**
 * The base the prototype's component extends: state, and a re-render on
 * change. `forceUpdate` is what the artifact runtime called it, and the
 * component calls it by that name.
 */
export class DCLogic {
    /** @param {Record<string, unknown>} props */
    constructor(props = {}) {
        this.props = props;
        /** @type {Record<string, any>} */
        this.state = {};
        /** @type {(() => void) | null} */
        this._apply = null;
    }

    /** @param {object | ((s: any) => object)} next */
    setState(next) {
        const patch = typeof next === 'function' ? next(this.state) : next;
        this.state = { ...this.state, ...patch };
        this.forceUpdate();
    }

    forceUpdate() {
        if (this._apply !== null) this._apply();
    }
}

/**
 * `a.b.c` against an object, and undefined rather than a throw when a step is
 * missing — a binding that points at nothing should leave the element alone,
 * not take the page down.
 *
 * @param {Record<string, any>} source
 * @param {string} path
 * @returns {unknown}
 */
function read(source, path) {
    /** @type {any} */
    let value = source;
    for (const step of path.split('.')) {
        if (value === null || value === undefined) return undefined;
        value = value[step];
    }
    return value;
}

/**
 * A React-shaped style object as CSS text.
 *
 * The prototype writes `flexDirection`, `fontSize`, `WebkitLineClamp`. Numbers
 * are treated as pixels for the properties where that is what React does, and
 * left bare for the unitless ones — getting this wrong is silent: `flex: 1px`
 * simply stops laying out.
 *
 */
const UNITLESS = new Set(['opacity', 'zIndex', 'flex', 'flexGrow', 'flexShrink', 'fontWeight', 'lineHeight', 'order']);

/**
 * @param {Record<string, string | number>} style
 * @returns {string}
 */
function toCss(style) {
    return Object.entries(style)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => {
            const name = key.replace(/^Webkit/, 'webkit').replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
            const unit = typeof value === 'number' && !UNITLESS.has(key) ? 'px' : '';
            return `${name.startsWith('webkit') ? `-${name}` : name}: ${value}${unit}`;
        })
        .join('; ');
}


/**
 * `createElement`, because the prototype builds four icons and the open page
 * with it, and those are real markup rather than bindings.
 *
 * It is the smallest thing that satisfies those eighteen calls: a tag, a props
 * object, and children. Nothing reconciles, nothing diffs — the caller throws
 * the result away and builds a new one on every render, which is what it did
 * before too.
 *
 * SVG needs its own namespace or the browser parses `<path>` as unknown HTML
 * and paints nothing, and `viewBox` is the one attribute that keeps its capital
 * letter there. Everything else camelCase becomes kebab, as React does.
 */
const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set(['svg', 'circle', 'path', 'polyline', 'rect', 'line', 'g', 'polygon']);

/**
 * @param {string} tag
 * @param {Record<string, any> | null} props
 * @param {...any} children
 * @returns {Element}
 */
export function createElement(tag, props, ...children) {
    const el = SVG_TAGS.has(tag) ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);

    for (const [name, value] of Object.entries(props ?? {})) {
        if (name === 'key' || value === undefined || value === null || value === false) continue;
        if (name === 'style' && typeof value === 'object') {
            el.setAttribute('style', toCss(value));
            continue;
        }
        if (name === 'className') {
            el.setAttribute('class', String(value));
            continue;
        }
        if (name.startsWith('on') && typeof value === 'function') {
            el.addEventListener(name.slice(2).toLowerCase(), /** @type {EventListener} */ (value));
            continue;
        }
        const attr = name === 'viewBox' ? name : name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
        el.setAttribute(attr, value === true ? '' : String(value));
    }

    for (const child of children.flat(Infinity)) {
        if (child === null || child === undefined || child === false) continue;
        el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
}

/** What the prototype calls it. */
export const React = { createElement, createRef };

/**
 * Applies one value to one element, by the kind of binding the attribute
 * names. Split out so the loop below reads as a list of kinds rather than a
 * chain of conditions.
 *
 * @param {Element} el
 * @param {string} attribute
 * @param {unknown} value
 */
function put(el, attribute, value) {
    if (attribute === 'data-text') {
        // A binding can carry a node: the prototype builds its icons and the
        // open page with `createElement`, and stringifying one of those would
        // print `[object HTMLElement]` where the drawing should be.
        if (value instanceof Node) {
            el.replaceChildren(value);
            return;
        }
        if (Array.isArray(value)) {
            el.replaceChildren(...value.map((v) => (v instanceof Node ? v : document.createTextNode(String(v)))));
            return;
        }
        el.textContent = value === undefined || value === null ? '' : String(value);
        return;
    }
    if (attribute === 'data-if') {
        // BOTH, because each alone is wrong for half this markup.
        //
        // `hidden` alone loses: most elements here carry an inline `display` —
        // flex, contents, inline-block — and an inline display beats the
        // attribute, so the attach menu and the results panel painted while
        // their state said false.
        //
        // `display` alone loses the other way: an element whose starting state
        // is the `hidden` attribute and which has no inline display is shown
        // by restoring `display: ''`, which restores nothing while `hidden` is
        // still on it. The settings drawer opened in the state and never on
        // the screen.
        //
        // The element's own display is remembered on the first pass so showing
        // it again restores what the markup gave it rather than a guess.
        const node = /** @type {HTMLElement} */ (el);
        if (node.dataset['ifDisplay'] === undefined) node.dataset['ifDisplay'] = node.style.display;
        node.hidden = !value;
        node.style.display = value ? (node.dataset['ifDisplay'] ?? '') : 'none';
        return;
    }
    if (attribute === 'data-style') {
        if (value && typeof value === 'object') {
            const node = /** @type {HTMLElement} */ (el);
            node.style.cssText = toCss(/** @type {Record<string, string | number>} */ (value));
            // A render under the pointer: the new style is what the element
            // declares from now on, and the hover goes back on top of it. See
            // `hovering` — without this the pointer leaving would restore a
            // value this render had already replaced.
            const worn = hovering.get(node);
            if (worn !== undefined) {
                worn.before = declaredNow(node, worn.names);
                node.style.cssText += ';' + worn.css;
            }
        }
        return;
    }
    const attr = attribute.slice('data-attr-'.length);
    if (value === false || value === undefined || value === null) el.removeAttribute(attr);
    else el.setAttribute(attr, value === true ? '' : String(value));
}

/**
 * Binds a subtree and returns the function that refreshes it.
 *
 * One recursive pass, because the markup nests: the library grid is a list of
 * groups and each group is a list of documents, so a scope has to carry the
 * outer item while the inner list resolves. A flat pass turned the inner
 * `data-for` into an attribute nobody could name, which is how this surfaced —
 * `'' is not a valid attribute name`.
 *
 * Generated rows are thrown away and rebuilt on every pass. The lists here are
 * a handful of rows and a rebuild is a frame; reconciling them would be the
 * framework this file is not allowed to become.
 *
 * @param {Element} root
 * @param {DCLogic & { renderVals: () => Record<string, any> }} component
 * @returns {() => void}
 */
export function bind(root, component) {
    /** @type {WeakSet<Element>} */
    const listening = new WeakSet();
    /**
     * The scope each generated row was rendered under, kept on the node
     * because a listener fires long after the pass that built it.
     *
     * @type {WeakMap<Element, Record<string, any>>}
     */
    const scopes = new WeakMap();
    /** @type {Element[]} */
    let generated = [];

    /**
     * @param {Element} el
     * @param {Record<string, any>} scope
     */
    function applyOne(el, scope) {
        for (const { name, value } of [...el.attributes]) {
            if (name === 'data-for' || name === 'data-as' || name === 'data-if-display') continue;

            if (name === 'data-ref') {
                // Resolved against the scope like every other binding, rather
                // than assumed: the component is what decides the shape.
                giveRef(read(scope, value), el, /** @type {any} */ (component), value);
                continue;
            }

            // Listeners are attached below, once per element.
            if (name.startsWith('data-on-')) continue;

            if (name === 'data-text' || name === 'data-if' || name === 'data-style' || name.startsWith('data-attr-')) {
                put(el, name, read(scope, value));
            }
        }

        if (!listening.has(el)) {
            for (const { name, value } of [...el.attributes]) {
                if (!name.startsWith('data-on-')) continue;
                const path = value;
                el.addEventListener(name.slice('data-on-'.length), (event) => {
                    const handler = read(scopeOf(el), path);
                    if (typeof handler === 'function') handler(event);
                });
            }
            // `style-hover` is literal CSS, not a binding: the markup carries
            // thirteen of them and nothing here read one, so thirteen controls
            // did not answer the pointer. It cannot be a stylesheet rule
            // because these elements are styled inline and an inline
            // declaration beats a class; it is applied and removed by hand for
            // the same reason. The declarations it removes are exactly the
            // ones it added, so an element's own inline style survives.
            const hover = el.getAttribute('style-hover');
            if (hover !== null) {
                const node = /** @type {HTMLElement} */ (el);
                const names = propertiesIn(hover);
                node.addEventListener('pointerenter', () => {
                    // What the element declares underneath, remembered on the
                    // way in and refreshed by any render that happens while
                    // the pointer is still here. Removing the hover's
                    // properties on the way out would otherwise take the
                    // element's OWN declaration with them: half of these
                    // override a colour that was already inline, and the
                    // control came back from a hover paler than it started.
                    hovering.set(node, { css: hover, names, before: declaredNow(node, names) });
                    node.style.cssText += ';' + hover;
                });
                node.addEventListener('pointerleave', () => {
                    const worn = hovering.get(node);
                    hovering.delete(node);
                    if (worn === undefined) return;
                    for (const name of names) {
                        const own = worn.before[name];
                        if (own === undefined || own === '') node.style.removeProperty(name);
                        else node.style.setProperty(name, own);
                    }
                });
            }
            listening.add(el);
        }
    }

    /**
     * @param {Element} el
     * @returns {Record<string, any>}
     */
    function scopeOf(el) {
        /** @type {Element | null} */
        let node = el;
        while (node !== null) {
            const own = scopes.get(node);
            if (own !== undefined) return own;
            node = node.parentElement;
        }
        return component.renderVals();
    }

    /**
     * @param {Element} el
     * @param {Record<string, any>} scope
     */
    function walk(el, scope) {
        if (el.tagName === 'TEMPLATE' && el.hasAttribute('data-for')) {
            const list = /** @type {unknown[]} */ (read(scope, el.getAttribute('data-for') ?? '')) ?? [];
            const alias = el.getAttribute('data-as') ?? 'item';
            const source = /** @type {HTMLTemplateElement} */ (el).content.firstElementChild;
            if (source === null) return;
            for (const item of list) {
                const clone = /** @type {Element} */ (source.cloneNode(true));
                el.parentNode?.insertBefore(clone, el);
                generated.push(clone);
                const inner = { ...scope, [alias]: item };
                scopes.set(clone, inner);
                walk(clone, inner);
            }
            return;
        }

        applyOne(el, scope);
        for (const child of [...el.children]) walk(child, scope);
    }

    return function apply() {
        for (const old of generated) old.remove();
        generated = [];
        walk(root, component.renderVals());
    };
}

/**
 * @param {DCLogic & { renderVals: () => Record<string, any>, componentDidMount?: () => void }} component
 * @param {Element} root
 */
export function mount(component, root) {
    const apply = bind(root, component);
    component._apply = apply;
    apply();
    component.componentDidMount?.();
}
