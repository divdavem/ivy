import { IvTemplate, IvView, IvDocument, IvNode, IvContainer, IvBlockContainer, IvElement, IvParentNode, IvText, IvFragment, IvCptContainer, IvEltListener, IvParamNode, IvLogger } from './types';
import { ΔD, Δp, ΔfStr, ΔfBool, ΔfNbr, Δf, Δlf, watch, unwatch, isMutating, createNewRefreshContext, commitChanges, version, reset, create, Δu, hasProperty, isDataObject } from '../trax/trax';

export let uidCount = 0; // counter used for unique ids (debug only, can be reset)

export const logger: IvLogger = {
    log(msg: string, ...optionalParams: any[]) {
        console.log.apply(console, arguments);
    },
    error(msg: string, ...optionalParams: any[]) {
        console.error.apply(console, arguments);
    }
}

function error(view: IvView, msg: string) {
    // temporary error management
    let v: IvView | null = view, infos: string[] = [];
    while (v) {
        if (v.template) {
            let t = v.template as Template;
            infos.push(`\n>> Template: "${t.templateName}" - File: "${t.filePath}"`);
        }
        v = v.parentView;
    }
    logger.error("IVY: " + msg + infos.join(""));
}

const PROP_TEMPLATE = "$template", PROP_LOGGER = "$logger";
let TPL_COUNT = 0;

interface TemplateController {
    $api?: any;
    $init?: () => void;
    $beforeRender?: () => void;
    $afterRender?: () => void;
}

/**
 * Template object created at runtime
 */
export class Template implements IvTemplate {
    uid = ++TPL_COUNT;
    view: IvView;
    tplApi: any = undefined;
    tplCtl: any = undefined;
    forceRefresh = false;
    watchCb: () => void;
    activeWatch = false;
    lastRefreshVersion = 0;
    processing = false;
    rendering = false;
    initialized = false;
    labels: { [label: string]: any[] } | undefined = undefined;

    constructor(public templateName: string, public filePath: string, public renderFn: (ζ: IvView, $api: any, $ctl: any, $template: IvTemplate) => void | undefined, public apiClass?: () => void, public ctlClass?: () => void, public hasHost = false) {
        // document is undefined in a node environment
        this.view = createView(null, null, 1, this);
        let self = this;
        this.watchCb = function () {
            self.notifyChange();
        }
        this.watchCb["$templateId"] = this.uid;
    }

    get document() {
        return this.view.doc;
    }

    set document(d: IvDocument) {
        this.view.doc = d;
    }

    get $api(): any | undefined {
        if (!this.tplApi) {
            if (this.apiClass) {
                this.tplApi = new this.apiClass();
            } else {
                let ctl = this.$ctl;
                if (ctl && ctl.$api) {
                    this.tplApi = ctl.$api;
                }
            }
        }
        return this.tplApi;
    }

    get $ctl(): TemplateController | undefined {
        if (!this.tplCtl && this.ctlClass) {
            this.tplCtl = new this.ctlClass();
            if (hasProperty(this.tplCtl, PROP_TEMPLATE)) {
                this.tplCtl[PROP_TEMPLATE] = this;
            }
            if (hasProperty(this.tplCtl, PROP_LOGGER)) {
                let v = this.view;
                this.tplCtl[PROP_LOGGER] = <IvLogger>{
                    log: logger.log,
                    error(msg: string, ...optionalParams: any[]) {
                        error(v, msg + (optionalParams.length ? " " + optionalParams.join(" ") : ""));
                    }
                };
            }
        }
        return this.tplCtl;
    }

    attach(element: any) {
        if (!this.view.rootDomNode) {
            let ctxt = this.view;
            if (!ctxt.doc) throw new Error("[iv] Template.document must be defined before calling Template.attach()");
            ctxt.rootDomNode = element;
            ctxt.anchorNode = ctxt.doc.createComment("template anchor"); // used as anchor in the parent domNode
            element.appendChild(ctxt.anchorNode);
            //appendChild(element, ctxt.anchorNode);
        } else {
            error(this.view, "Template host cannot be changed once set");
        }
        return this;
    }

    registerLabel(label: string, object: any) {
        if (!this.labels) {
            this.labels = {};
        }
        let target = this.labels[label];
        if (!target) {
            target = this.labels[label] = [object];
        } else {
            target.push(object);
        }
    }

    /**
     * Return the first element labelled as per the argument
     * e.g. for <div #foo/> -> query("#foo") will return the DIV DOM element
     * @param label 
     * @return the DOM element or the Component $api or null if nothing is found
     */
    query(label: string, all: boolean = false): any | any[] | null {
        if (this.rendering) return null; // query cannot be used during template rendering
        if (label && label.charAt(0) !== '#') {
            error(this.view, "[$template.query()] Invalid label argument: '" + label + "' (labels must start with #)");
            return null;
        }
        let target = this.labels ? this.labels[label] || null : null;
        if (target && target.length) {
            if (!all) return target[0];
            return target
        }
        return null;
    }

    notifyChange() {
        this.render();
    }

    disconnectObserver() {
        if (this.activeWatch) {
            unwatch(this.$api, this.watchCb);
            unwatch(this.$ctl, this.watchCb);
            this.activeWatch = false;
        }
    }

    render(data?: any) {
        if (this.processing) return this;
        this.processing = true;
        // console.log('refresh', this.uid)
        let $api = this.$api, $ctl = this.$ctl, view = this.view;

        if ($ctl && !isDataObject($ctl)) {
            error(view, "Template controller must be a @Controller Object - please check: " + this.ctlClass!.name);
            this.tplCtl = this.ctlClass = undefined;
        }

        if ($api && data) {
            if (!isMutating($api)) {
                createNewRefreshContext();
            }
            this.disconnectObserver();
            // inject data into params
            for (let k in data) if (data.hasOwnProperty(k)) {
                $api[k] = data[k];
            }
        }
        let bypassRender = !this.forceRefresh, nodes = view.nodes;
        if (!nodes || !nodes[0] || !(nodes[0] as IvNode).attached) {
            bypassRender = false; // internal blocks may have to be recreated if root is not attached
        }
        if (bypassRender && version($api) + version($ctl) > this.lastRefreshVersion) {
            bypassRender = false;
        }
        if (!bypassRender) {
            // console.log(">>>>>>>>>>>>>>>>> REFRESH uid:", this.uid, "lastRefreshVersion:", this.lastRefreshVersion, "forceRefresh: ", this.forceRefresh);
            if ($ctl) {
                if (!this.initialized) {
                    callLCHook(view, $ctl, "$init");
                    this.initialized = true;
                }
                callLCHook(view, $ctl, "$beforeRender");
            }
            this.rendering = true;
            this.labels = undefined;
            view.lastRefresh++;
            view.instructions = undefined;
            try {
                this.renderFn(view, $api, $ctl, this);
            } catch (ex) {
                error(view, "Template execution error\n" + (ex.message || ex));
            }

            this.rendering = false;

            if ($ctl) {
                // changes in $afterRender() cannot trigger a new render to avoid infinite loops
                callLCHook(view, $ctl, "$afterRender");
            }
            commitChanges($api); // will change p or state version
            this.forceRefresh = false;
            this.lastRefreshVersion = version($api) + version($ctl);
        }

        if (!this.activeWatch) {
            watch($api, this.watchCb);
            if ($ctl) {
                watch($ctl, this.watchCb);
            }
            this.activeWatch = true;
        }
        this.processing = false;
        return this;
    }
}

function callLCHook(view: IvView, $ctl: TemplateController, hook: "$init" | "$beforeRender" | "$afterRender") {
    // life cycle hook
    if ($ctl[hook]) {
        try {
            $ctl[hook]!();
        } catch (ex) {
            error(view, hook + " hook execution error\n" + (ex.message || ex));
        }
    }
}

// member of the view object
function ViewCreateElement(this: IvView, name: string, namespace?: string): any {
    namespace = namespace || this.namespace;
    if (namespace) {
        return this.doc.createElementNS(namespace, name);
    }
    return this.doc.createElement(name);
}

function createView(parentView: IvView | null, container: IvContainer | null, srcUID: number, template?: IvTemplate): IvView {
    // srcUID is a unique number to help debugging
    let view: IvView = {
        kind: "#view",
        uid: "view" + (++uidCount),
        nodes: null,
        namespace: undefined,
        namespaces: undefined,
        doc: null as any,
        parentView: parentView,
        cm: true,
        cmAppends: null,
        lastRefresh: 0,
        container: null,
        projectionHost: null,
        template: template,
        rootDomNode: null,
        anchorNode: null,
        expressions: undefined,
        oExpressions: undefined,
        instructions: undefined,
        paramNode: undefined,
        createElement: ViewCreateElement
    }
    // console.log("createView: " + view.uid + " - called from " + srcUID);
    if (parentView) {
        setParentView(view, parentView, container);
    } else {
        view.doc = (typeof document !== "undefined") ? document as any : null as any;
    }
    return view;
}

/**
 * Register a labelled object (e.g. DOM node, component...) on the view template
 * @param v 
 * @param object the object to register on the labels
 * @param labels array of names, collection indicator (e.g. ["#header", 0, "#buttons", 1])
 */
function registerLabels(v: IvView, object: any, labels?: any[] | 0) {
    if (labels) {
        // get the template view
        let view: IvView | null = v;
        while (view && !view.template) {
            view = view.parentView;
        }
        if (view) {
            let tpl = view.template!, len = labels.length;
            for (let i = 0; len > i; i++) {
                (tpl as Template).registerLabel(labels[i], object);
            }
        }
    }
}

function setParentView(v: IvView, pv: IvView, container: IvContainer | null) {
    v.parentView = pv;
    v.doc = pv.doc;
    v.container = container;
    v.rootDomNode = pv.rootDomNode;
    if (pv.namespace) {
        let ns = pv.namespace;
        v.namespace = ns;
        v.namespaces = [ns];
    }
}

export function template(template: string): () => IvTemplate {
    return function () {
        return new Template("", "", () => { })
    }
};

/**
 * Template runtime factory
 * cf. sample code generation in generator.spec
 * @param renderFn 
 */
export function ζt(tplName: string, tplFile: string, renderFn: (ζ: any, $api: any, $ctl: any, $template: IvTemplate) => void, hasHost?: number, argumentClass?, stateClass?): () => IvTemplate {
    return function () {
        return new Template(tplName, tplFile, renderFn, argumentClass || undefined, stateClass, hasHost === 1);
    }
}

/**
 * Unchanged symbol
 * Used as a return value for expressions (cf. ζe) to notify that a value hasn't changed
 */
export const ζu = []; // must be an array to be used for undefined statics

// ----------------------------------------------------------------------------------------------
// Runtime instructions

// Root view initialization
// e.g. let ζc = ζinit(ζ, ζs0, 2);
export function ζinit(v: IvView, staticCache: Object, nbrOfNodes: number): boolean {
    // staticCache is an object that can be used to hold class-level cached data
    let cm = v.cm;
    if (cm) {
        v.nodes = new Array(nbrOfNodes);
        if (!v.cmAppends) {
            // cmAppends is already defined when the template is called from another template
            v.cmAppends = [];
            if (v.anchorNode) {
                // this is the root template
                v.cmAppends[0] = function (n: IvNode, domOnly: boolean) {
                    // console.log("cmAppends #1");
                    if (n.domNode) {
                        v.rootDomNode.insertBefore(n.domNode, v.anchorNode);
                    } else {
                        n.domNode = v.rootDomNode;
                    }
                }
            }
        }
    } else {
        v.cmAppends = null;
    }
    return cm;
}

// Sub-view creation
// e.g. ζ1 = ζview(ζ, 0, 1, 2, ++ζi1);
export function ζview(pv: IvView, iFlag: number, containerIdx: number, nbrOfNodes: number, instanceIdx: number) {
    // retrieve container to get previous view
    // container must exist otherwise the view cannot be retrieved
    let cn = pv.nodes![containerIdx], view: IvView;
    if (!cn || !cn.attached) {
        error(pv, "Invalid ζview call: container must be attached (" + (cn ? cn.uid : "XX") + ") - pview: " + pv.uid + " containerIdx: " + containerIdx);
    }
    if (cn.kind === "#container") {
        if ((cn as IvContainer).subKind === "##block") {
            let cnt = cn as IvBlockContainer, views = cnt.views;
            if (instanceIdx === 1) {
                cnt.insertFn = null;
            }
            // console.log("ζview", cnt.uid, instanceIdx, cnt.domNode === undefined)
            if (instanceIdx === 1 && cnt.views.length > 1) {
                // previous views are moved to the view pool to be re-used if necessary
                cnt.previousNbrOfViews = views.length;
                view = views.shift()!;
                if (cnt.viewPool.length) {
                    cnt.viewPool = views.concat(cnt.viewPool);
                } else {
                    cnt.viewPool = views;
                }
                cnt.views = [view];
                // this view was already attached so doesn't need to be inserted again
            } else {
                view = cnt.views[instanceIdx - 1];
                if (!view) {
                    if (cnt.viewPool.length > 0) {
                        // console.log("view: retrieve from pool: ", cnt.uid)
                        if (!cnt.insertFn) {
                            cnt.insertFn = getViewInsertFunction(pv, cnt);
                        }
                        view = views[instanceIdx - 1] = cnt.viewPool.shift()!;
                        insertInDom(view.nodes![0], cnt.insertFn, 1);
                    } else {
                        view = views[instanceIdx - 1] = createView(pv, cnt, 2);
                        view.nodes = new Array(nbrOfNodes);
                        if (pv.cm && cnt.cmAppend) {
                            view.cmAppends = [cnt.cmAppend];
                        } else if (!pv.cm) {
                            view.cmAppends = [getViewInsertFunction(pv, cnt)];
                        }
                    }
                }
            }
            cnt.lastRefresh = view.lastRefresh = pv.lastRefresh;
        } else {
            // in this case cn is a component container and iFlag > 0
            // console.log("view: get content view #1", pv.uid);
            let cnt = cn as IvCptContainer;
            view = cnt.contentView!;
            if (!view) {
                view = cnt.contentView = createView(pv, cnt, 3);
                view.nodes = new Array(nbrOfNodes);
            }
            // cmAppends will be already defined in ζins() as the current view is deferred
            view.lastRefresh = pv.lastRefresh;
        }
    } else if (cn.kind === "#param") {
        // cn is a param node
        let pn = cn as IvParamNode;
        // console.log("view: get content view #2", pv.uid);
        view = pn.contentView!;
        if (!view) {
            view = pn.contentView = createView(pv, null, 4);
            if (pn.viewPool) {
                pn.viewPool[pn.viewInstanceIdx] = view;
            }
            view.nodes = new Array(nbrOfNodes);
            view.paramNode = pn;
        }
    }
    return view!;
}

export function ζviewD(pv: IvView, iFlag: number, containerIdx: number, nbrOfNodes: number, instanceIdx: number) {
    let v = ζview(pv, iFlag, containerIdx, nbrOfNodes, instanceIdx);
    // console.log("viewD - created:", v.uid, v.instructions ? v.instructions.length : "XX")

    // reset instructions
    if (iFlag === 1) {
        v.instructions = [];
    } else {
        let v2 = v, h = iFlag - 1;
        while (h > 0) {
            v2 = v2.parentView!;
            h--;
        }
        if (!v2.instructions) {
            v2.instructions = [];
        }
        v.instructions = v2.instructions;
    }
    if (v.cm && !v.cmAppends) {
        addInstruction(v, initView, [v, pv, containerIdx]);
    }
    return v;
}

function initView(v: IvView, parentView: IvView, containerIdx: number) {
    // initialize cmAppend when view has been created in a deferred context
    // i.e. container was created with cntD and its cmAppend was not defined
    let cn = parentView.nodes![containerIdx];
    if (cn.kind === "#container" && !v.cmAppends && (cn as IvContainer).cmAppend) {
        // console.log("initView:", v.uid, "container:", cn.uid)
        v.cmAppends = [(cn as IvContainer).cmAppend!];
    }
}

function addInstruction(v: IvView, func: Function, args: any[]) {
    // console.log("addInstruction in", v.uid, " -> ", func.name);
    v.instructions!.push(func);
    v.instructions!.push(args);
}

function runInstructions(v: IvView) {
    // console.log("runInstructions in", v.uid, "instructions count = ", v.instructions ? v.instructions.length / 2 : 0)
    if (v.instructions) {
        let instr = v.instructions.slice(0), len = instr.length;
        v.instructions.splice(0, len); // empty the array (may be referenced by multiple views)
        v.instructions = undefined;
        if (len) {
            for (let i = 0; len > i; i += 2) {
                // console.log("   -> run instruction #" + (i / 2), instr[i].name);
                instr[i].apply(null, instr[i + 1]);
            }
        }
    }
}

function getViewInsertFunction(pv: IvView, cnt: IvContainer | IvFragment) {
    // determine the append mode
    let { position, nextDomNd, parentDomNd } = findNextSiblingDomNd(pv, cnt);
    // console.log(`findNextSiblingDomNd of ${cnt.uid} position=${position} nextDomNd=${nextDomNd ? nextDomNd.uid : "XX"} parentDomNd=${parentDomNd ? parentDomNd.uid : "XX"}`)
    if (position === "beforeChild" || position === "lastOnRoot") {
        return function (n: IvNode, domOnly: boolean) {
            // console.log("cmAppends #2.1", n.uid, domOnly);
            if (n.domNode) {
                parentDomNd.insertBefore(n.domNode, nextDomNd);
            } else {
                n.domNode = parentDomNd;
            }
        };
    } else if (position === "lastChild") {
        return function (n: IvNode, domOnly: boolean) {
            // console.log("cmAppends #2.2", n.uid, domOnly);
            if (n.domNode) {
                // console.log("getViewInsertFunction: appendChild", n.domNode.uid, "in", parentDomNd.uid)
                parentDomNd.appendChild(n.domNode);
            } else {
                n.domNode = parentDomNd;
            }
        };
    } else {
        return function () {
            // console.log("cmAppends #2.3");
            console.warn("TODO: VALIDATE VIEW APPEND: ", position)
            logView(pv, "getViewInsertFunction for " + cnt.uid)
        }
    }
}

/**
 * Delete container content
 */
function checkContainer(v: IvView, idx: number, firstTime: boolean) {
    let container = v.nodes![idx] as IvContainer;
    if (!container || container.subKind !== "##block") return; // happens when block condition has never been true
    let bc = container as IvBlockContainer, lastRefresh = bc.lastRefresh;
    // console.log("checkContainer", container.uid, "in=", v.uid, idx, "container.lastRefresh=", lastRefresh, "v.lastRefresh=", v.lastRefresh, "firstTime:", firstTime);

    if (!firstTime && lastRefresh !== v.lastRefresh) {
        // remove all nodes from DOM
        removeFromDom(v, bc);
    } else {
        let views = bc.views, nbrOfViews = views.length;
        if (!firstTime) {
            // console.log("previousNbrOfViews", bc.previousNbrOfViews, "nbrOfViews", nbrOfViews);
            if (nbrOfViews !== bc.previousNbrOfViews) {
                // disconnect the nodes that are still attached in the pool
                let pool = bc.viewPool, len = pool.length, view: IvView;
                for (let i = 0; len > i; i++) {
                    view = pool[i];
                    removeFromDom(view, view.nodes![0]);
                }
            }
            bc.previousNbrOfViews = nbrOfViews; // all views are immediately inserted
        }
    }
}

function insertInDom(nd: IvNode, insertFn: (n: IvNode, domOnly: boolean) => void, origin: number) {
    // this function can only be called when cm = false
    // note: origin is only used for debug purposes
    // console.log("insertInDom", origin, nd.attached, nd.domNode.uid)
    if (nd.attached) return;
    insertFn(nd, true);
    nd.attached = true;
    if (nd.kind === "#fragment") {
        let f = nd as IvFragment, ch = f.firstChild;
        while (ch) {
            insertInDom(ch, insertFn, 4);
            ch = ch.nextSibling;
        }
    } else if (nd.kind === "#container") {
        let k = (nd as IvContainer).subKind;
        if (k === "##cpt") {
            let cc = nd as IvCptContainer, tpl = cc.template as Template, root = tpl ? tpl.view.nodes![0] : null;
            if (tpl) {
                // console.log("forceRefresh #1");
                tpl.forceRefresh = true;
            }
            if (root) insertInDom(root, insertFn, 5);
        } else if (k === "##block") {
            let cb = nd as IvBlockContainer, views = cb.views;
            for (let i = 0; views.length > i; i++) {
                insertInDom(views[i].nodes![0], insertFn, 6);
            }
        }
    }
    if (nd.kind === "#fragment" || nd.kind === "#element") {
        let cv = (nd as IvFragment | IvElement).contentView;
        if (cv) {
            insertInDom(cv.nodes![0], insertFn, 7);
        }
    }
}

// End view
// e.g. ζend(ζ, ζc, 0)
export function ζend(v: IvView, cm: boolean, containerIndexes?: (number[] | 0)) {
    if (containerIndexes) {
        let len = containerIndexes.length;
        for (let i = 0; len > i; i++) {
            checkContainer(v, containerIndexes[i], v.cm);
        }
    }
    if (!v.cm) return;

    v.cm = false;
    v.cmAppends = null;
}

export function ζendD(v: IvView, cm: boolean, containerIndexes?: (number[] | 0)) {
    if (v.paramNode) {
        let pn = v.paramNode;
        if (!pn.dataHolder) {
            error(v, "ζendD dataHoler should be defined");
        } else if (v.instructions && v.instructions.length) {
            addInstruction(v, ζend, [v, cm, containerIndexes]);
            if (!pn.data || pn.data.kind === "#view") {
                // paramNode is associated to an IvContent param
                pn.dataHolder[pn.dataName] = v
            } else if (pn.data) {
                pn.data["$content"] = v;
            } else {
                console.warn("TODO: ζendD no data")
            }
        }
    } else {
        addInstruction(v, ζend, [v, cm, containerIndexes]);
    }
}

function finalizeParamNode(v: IvView) {
    let pn = v.paramNode;
    if (!pn) return;
    if (!pn.data || pn.data.kind === "#view") {
        // paramNode is associated to an IvContent param
        pn.dataHolder[pn.dataName] = v
    } else if (pn.data) {
        pn.data["$content"] = v;
    } else {
        console.warn("TODO: ζendD no data")
    }
}

// Element creation function
// e.g. ζelt(ζ, ζc, 0, 0, 0, "div", 1);
export function ζelt(v: IvView, cm: boolean, idx: number, parentLevel: number, name: string, hasChildren: 0 | 1, labels?: any[] | 0, staticAttributes?: any[] | 0, staticProperties?: any[] | 0) {
    if (!cm) {
        if (labels) {
            registerLabels(v, v.nodes![idx].domNode, labels);
        }
        return;
    }
    let e = v.createElement(name);

    if (staticAttributes) {
        let len = staticAttributes.length;
        for (let i = 0; len > i; i += 2) {
            e.setAttribute(staticAttributes[i], staticAttributes[i + 1]);
            // setAttribute(e, staticAttributes[i], staticAttributes[i + 1]);
        }
    }
    if (staticProperties) {
        let len = staticProperties.length;
        for (let j = 0; len > j; j += 2) {
            e[staticProperties[j]] = staticProperties[j + 1];
        }
    }
    let nd: IvElement = {
        kind: "#element",
        uid: "elt" + (++uidCount),
        idx: idx,
        parentIdx: -1,
        ns: "",
        domNode: e,
        attached: true,            // always attached when created
        nextSibling: undefined,
        firstChild: undefined,
        lastChild: undefined,
        contentView: null
    }
    v.nodes![idx] = nd;
    registerLabels(v, e, labels);
    v.cmAppends![parentLevel]!(nd, false); // append in the parent DOM
    if (hasChildren) {
        v.cmAppends![parentLevel + 1] = function (n: IvNode, domOnly: boolean) {
            // console.log("cmAppends #3");
            if (n.domNode) {
                e.appendChild(n.domNode);
                // appendChild(e, n.domNode);
            } else {
                n.domNode = e;
            }
            if (!domOnly) {
                appendChildToNode(nd, n);
            }
        }
    }
}

export function ζeltD(v: IvView, cm: boolean, idx: number, parentLevel: number, name: string, hasChildren: 0 | 1, labels?: any[] | 0, staticAttributes?: any[], staticProperties?: any[]) {
    if (!cm) return;
    addInstruction(v, ζelt, [v, cm, idx, parentLevel, name, hasChildren, labels, staticAttributes, staticProperties]);
}

// e.g. start: ζxmlns(ζ, 0, 1, "http://www.w3.org/2000/svg");
// or end: ζxmlns(ζ, 0, 0);
export function ζxmlns(v: IvView, iFlag: number, ns?: string) {
    // if ns is provided, it is the start of a new xmlns section / otherwise it is the end
    if (ns) {
        // start
        if (v.namespaces) {
            v.namespaces.push(ns);
        } else {
            v.namespaces = [ns];
        }
        v.namespace = ns;
    } else {
        // end
        let len = v.namespaces!.length;
        if (len === 1) {
            v.namespace = v.namespaces = undefined;
        } else {
            v.namespaces!.pop();
            v.namespace = v.namespaces![len - 2];
        }
    }
}

export function ζxmlnsD(v: IvView, iFlag: number, ns?: string) {
    addInstruction(v, ζxmlns, [v, iFlag, ns]);
}

function appendChildToNode(p: IvParentNode, child: IvNode) {
    if (!p.firstChild) {
        p.firstChild = p.lastChild = child;
        child.nextSibling = undefined;
    } else {
        p.lastChild!.nextSibling = child
        p.lastChild = child;
    }
    child.parentIdx = p.idx;
}

// Text creation function
// e.g. ζtxt(ζ, ζc, 0, 1, 1, " Hello World ", 0);
export function ζtxt(v: IvView, cm: boolean, iFlag: number, idx: number, parentLevel: number, labels: any[] | 0, statics: string | string[], nbrOfValues: number, ...values: any[]) {
    // console.log("ζtxt", idx, nbrOfValues);
    let nd: IvText;
    if (!nbrOfValues) {
        // static node: nbrOfValues === 0
        if (!cm) {
            if (labels) registerLabels(v, v.nodes![idx].domNode, labels);
            return;
        }
        nd = createNode(v.doc.createTextNode(statics as string), undefined);
        registerLabels(v, nd.domNode, labels);
    } else {
        // dynamic node
        let pieces: string[], val: any, changed = false;
        if (cm) {
            pieces = (statics as string[]).slice(0);
        } else {
            nd = v.nodes![idx] as IvText;
            pieces = nd.pieces!;
        }
        for (let i = 0; nbrOfValues > i; i++) {
            val = getExprValue(v, iFlag, values[i]);
            if (val !== ζu) {
                changed = true;
                pieces![1 + i * 2] = (val === null || val === undefined) ? "" : val;
            }
        }

        if (cm) {
            // console.log("create text node ", pieces.join(""));
            nd = createNode(v.doc.createTextNode(pieces.join("") as string), pieces);
            registerLabels(v, nd.domNode, labels);
        } else {
            if (changed) {
                // console.log("set ", idx, nd!.uid, nd!.domNode.uid, pieces.join(""))
                nd!.domNode.textContent = pieces.join("");
            }
            registerLabels(v, nd!.domNode, labels);
            return;
        }
    }

    v.nodes![idx] = nd;
    v.cmAppends![parentLevel]!(nd, false); // append in the parent DOM

    function createNode(domNode, pieces): IvText {
        return {
            kind: "#text",
            uid: "txt" + (++uidCount),
            domNode: domNode,
            attached: true,
            idx: idx,
            parentIdx: -1,
            pieces: pieces,
            nextSibling: undefined
        }
    }
}

export function ζtxtD(v: IvView, cm: boolean, iFlag: number, idx: number, parentLevel: number, labels: any[] | 0, statics: string | string[], nbrOfValues: number, ...values: any[]) {
    // console.log("ζtxtD");
    let args = [v, cm, iFlag, idx, parentLevel, labels, statics, nbrOfValues]
    for (let i = 0; nbrOfValues > i; i++) {
        args.push(values[i]);
    }
    addInstruction(v, ζtxt, args);
}

// Expression binding
// e.g. ζe(ζ, 0, name)
export function ζe(v: IvView, idx: number, value: any) {
    if (!v.expressions) {
        // first time, expression is considered changed
        v.expressions = [];
        v.expressions[idx] = value;
    } else {
        let exp = v.expressions;
        //console.log("ζe", idx, value, exp)
        if (exp.length > idx && exp[idx] === value) return ζu;
        exp[idx] = value;
    }
    return value;
}

function getExprValue(v: IvView, iFlag: number, exprValue: any) {
    // exprValue is an array if instHolderIdx>0 as expression was deferred
    if (iFlag) {
        if (exprValue[2]) {
            let exprs = v.oExpressions!;
            // one-time expression
            if (exprs[2 * exprValue[0]]) {
                // already read
                return ζu;
            }
            exprs[2 * exprValue[0]] = 1;
            return exprValue[1];
        }
        return ζe(v, exprValue[0], exprValue[1]);
    }
    return exprValue;
}

// One-time expression evaluation
// e.g. ζo(ζ, 0, ζc? name : ζu)
export function ζo(v: IvView, idx: number, value: any, iFlag?: number): any {
    let exprs = v.oExpressions;
    if (!exprs) {
        exprs = v.oExpressions = [];
    }
    if (iFlag) {
        if (!exprs[2 * idx]) {
            // list of read, result
            // where read = 0 | 1
            // and result = [idx, value, 1]
            let res = [idx, value, 1]
            exprs[2 * idx] = 0;
            exprs[1 + 2 * idx] = res;
            return res;
        } else {
            return exprs[1 + 2 * idx];
        }
    } else {
        if (!exprs[2 * idx]) {
            exprs[2 * idx] = 1;
            return value;
        }
        return ζu;
    }
}

// Fragment creation function
// e.g. 
export function ζfra(v: IvView, cm: boolean, idx: number, parentLevel: number) {
    if (!cm) return;
    let nd: IvFragment = {
        kind: "#fragment",
        uid: "fra" + (++uidCount),
        idx: idx,
        parentIdx: -1,
        ns: "",
        domNode: undefined,
        attached: true,            // always attached when created
        nextSibling: undefined,
        firstChild: undefined,
        lastChild: undefined,
        contentView: null
    }
    v.nodes![idx] = nd;
    let parentCmAppend = v.cmAppends![parentLevel]!;
    parentCmAppend(nd, false);
    v.cmAppends![parentLevel + 1] = function (n: IvNode, domOnly: boolean) {
        // console.log("cmAppends #4 ", n.uid, domOnly);
        parentCmAppend(n, true);
        if (!domOnly) {
            appendChildToNode(nd, n);
        }
    }
}

export function ζfraD(v: IvView, cm: boolean, idx: number, parentLevel: number) {
    addInstruction(v, ζfra, [v, cm, idx, parentLevel]);
}

// Container creation
// e.g. ζcnt(ζ, ζc, 1, 1, 1);
export function ζcnt(v: IvView, cm: boolean, idx: number, parentLevel: number, type: number) {
    if (!cm) return;
    let nd = createContainer(idx, null, type)!;
    v.nodes![idx] = nd;
    initContainer(v, nd, parentLevel);
    return nd;
}

function createContainer(idx: number, cmAppend: null | ((n: IvNode, domOnly: boolean) => void), type: number): IvContainer | null {
    let nd: IvContainer;
    if (type === 1) {
        // block container
        nd = <IvBlockContainer>{
            kind: "#container",
            subKind: "##block",
            uid: "cnb" + (++uidCount),
            idx: idx,
            parentIdx: -1,
            ns: "",
            domNode: undefined,
            attached: true,            // always attached when created
            nextSibling: undefined,
            views: [],
            viewPool: [],
            cmAppend: cmAppend,
            lastRefresh: 0,
            previousNbrOfViews: 0,
            insertFn: null
        };
    } else if (type === 2) {
        // cpt container
        nd = <IvCptContainer>{
            kind: "#container",
            subKind: "##cpt",
            uid: "cnc" + (++uidCount),
            idx: idx,
            parentIdx: -1,
            ns: "",
            domNode: undefined,
            attached: true,            // always attached when created
            nextSibling: undefined,
            cmAppend: cmAppend,
            template: null,         // current component template
            data: null,           // shortcut to cptTemplate.params
            contentView: null,
            dynamicParams: undefined
        }
        // console.log("container created", nd.uid);
    } else {
        console.warn("TODO: new cnt type");
        return null;
    }
    return nd;
}

function initContainer(v: IvView, container: IvContainer, parentLevel: number) {
    // called when 
    if (v.cmAppends) {
        let parentCmAppend = v.cmAppends![parentLevel]!,
            cmAppend = function (n: IvNode, domOnly: boolean) {
                // console.log("initContainer: append", n.uid, n.domNode ? n.domNode.uid : "XX", "parentLevel:", parentLevel, "in", v.uid, "(container: " + container.uid + ")");
                parentCmAppend(n, true); // append container content
            };
        container.cmAppend = cmAppend;
        parentCmAppend(container, false); // append container in parent view
    }
}

export function ζcntD(v: IvView, cm: boolean, idx: number, parentLevel: number, type: number) {
    if (!cm) return;
    let nd = createContainer(idx, null, type)!;
    v.nodes![idx] = nd;
    addInstruction(v, initContainer, [v, nd, parentLevel]);
}


// Component Definition (& call if no params and no content)
// e.g. ζcpt(ζ, ζc, 2, 0, ζe(ζ, 0, alert), 1, ζs1);
export function ζcpt(v: IvView, cm: boolean, iFlag: number, idx: number, parentLevel: number, exprCptRef: any, callImmediately: number, labels?: any[] | 0, staticParams?: any[] | 0, dynParamNames?: string[]) {
    let container: IvCptContainer;
    // console.log("ζcpt", cm, v.uid, "idx: " + idx, exprCptRef)
    if (cm) {
        // creation mode
        iFlag = iFlag || 0;

        // create cpt container if not already done in ζcptD
        container = (v.nodes![idx] as IvCptContainer) || ζcnt(v, cm, idx, parentLevel, 2) as IvCptContainer;

        if (!container.template) {
            // even if we are in cm we could already have gone through this code if component is deferred
            // cf. ζcptD - in which case the template will be defined

            let cptRef = getExprValue(v, iFlag, exprCptRef);
            if (cptRef === ζu) {
                console.error("[iv] Invalid component ref")
                return;
            }
            let tpl: Template = container.template = cptRef()!;
            setParentView(tpl.view, v, container);
            tpl.disconnectObserver();
            let p = container.data = tpl.$api;
            if (staticParams) {
                // initialize static params
                let len = staticParams.length;
                if (!p && len) {
                    error(v, "Invalid parameter: " + staticParams[0]);
                } else {
                    for (let i = 0; len > i; i += 2) {
                        if (hasProperty(p, staticParams[i])) {
                            p[staticParams[i]] = staticParams[i + 1];
                        } else {
                            error(v, "Invalid parameter: " + staticParams[i])
                        }
                    }
                }
            }
        }
    } else {
        // update mode
        container = v.nodes![idx] as IvCptContainer;

        // if contains list params, reset the tempLists
        if (container.lists) {
            container.lists.sizes = {};
        }
    }
    if (dynParamNames) {
        container.dynamicParams = {};
    }
    if (callImmediately) {
        ζcall(v, idx, container, labels, dynParamNames);
    }
}

export function ζcptD(v: IvView, cm: boolean, iFlag: number, idx: number, parentLevel: number, exprCptRef: any, callImmediately: number, labels?: any[] | 0, staticParams?: any[] | 0, dynParamNames?: string[]) {
    // component will be created to hold data nodes - but not fully initialized
    ζcpt(v, cm, iFlag, idx, parentLevel, exprCptRef, callImmediately, labels, staticParams, dynParamNames);
    addInstruction(v, initContainer, [v, v.nodes![idx], parentLevel]);
}

// Component call - used when a component has content, params or param nodes
export function ζcall(v: IvView, idx: number, container?: IvCptContainer | 0, labels?: any[] | 0, dynParamNames?: string[]) {
    container = container || v.nodes![idx] as IvCptContainer;
    let tpl = container ? container.template as Template : null;
    if (tpl) {
        let cm = v.cm;
        tpl.view.lastRefresh = v.lastRefresh - 1; // will be incremented by refresh()

        cleanDataLists(container);

        if (container.contentView) {
            tpl.$api.$content = container.contentView;
            let instr = container.contentView.instructions;
            if (instr && instr.length) {
                // console.log("forceRefresh #2 - ", instr.length);
                tpl.forceRefresh = true;
            }
        }
        if (cm) {
            // define cmAppend
            tpl.view.cmAppends = [container!.cmAppend!];
        } else {
            if (dynParamNames) {
                // reset the dynamic param nodes that have not been processed
                let len = dynParamNames.length, dp = (container ? container.dynamicParams : {}) || {}, params = tpl.$api;
                for (let i = 0; len > i; i++) {
                    if (!dp[dynParamNames[i]]) {
                        // this param node has not been called - so we need to reset it
                        // console.log("reset", dynParamNames[i]);
                        reset(params, dynParamNames[i]);
                    }
                }
            }

            let root = tpl.view.nodes![0];
            if (!root.attached) {
                // console.log("forceRefresh #3");
                tpl.forceRefresh = true;
                let insertFn = getViewInsertFunction(v, container!);
                insertInDom(root, insertFn, 2);
            }
        }
        if (labels) {
            registerLabels(v, tpl.$api, labels);
        }
        tpl.render();
    }
}

export function ζcallD(v: IvView, idx: number, container?: IvCptContainer | 0, labels?: any[] | 0, dynParamNames?: string[]) {
    addInstruction(v, ζcall, [v, idx, container, labels, dynParamNames]);
}

function identifyPNodeList(v: IvView, pn: IvParamNode, name: string, dataParent: any) {
    if (!hasProperty(dataParent, name)) {
        if (hasProperty(dataParent, name + "List")) {
            pn.dataIsList = true;
            pn.dataName = name + "List";
        } else {
            error(v, "Invalid parameter node: <." + name + ">");
            // console.log(pn.uid, ">>>", dataParent)
        }
    } else {
        pn.dataIsList = false;
    }
}

export function ζpnode(v: IvView, cm: boolean, iFlag: number, idx: number, parentIndex: number, name: string, instanceIdx: number, labels?: any[] | 0, staticParams?: any[] | 0, dynParamNames?: string[]) {
    let pnd: IvParamNode, vNodes = v.nodes!, updateMode = false;
    // Warning: this function may not be called during cm (e.g. if defined in a conditional block)
    // console.log("ζpnode", v.uid, cm, "idx: " + idx, "parentIndex: " + parentIndex)
    if (!vNodes[idx]) {
        // create and register param node
        pnd = {
            kind: "#param",
            uid: "pnd" + (++uidCount),
            idx: idx,
            parentIdx: parentIndex,
            nextSibling: undefined,
            domNode: undefined,
            attached: true,
            dataName: name,
            dataHolder: undefined,
            data: undefined,
            dataIsList: undefined,
            contentView: undefined,
            dynamicParams: undefined,
            viewInstanceIdx: instanceIdx,
            viewPool: undefined
        }
        // console.log("ζpnode: create " + pnd.uid)
        vNodes[idx] = pnd;
    } else {
        pnd = (vNodes[idx] as IvParamNode);
        let viewPool = pnd.viewPool;
        if (instanceIdx > 0 && !viewPool) {
            viewPool = pnd.viewPool = [];
            viewPool[pnd.viewInstanceIdx] = pnd.contentView!;
            // console.log(">>> ζpnode: save in pool: " + pnd.viewInstanceIdx);
        }
        if (viewPool) {
            pnd.contentView = viewPool[instanceIdx];
            // warning: contentView may be undefined -> in this case the view will be created in saved in the pool through ζview
            // console.log(">>> ζpnode: retrieve contentView from pool: " + instanceIdx + " " + (pnd.contentView ? pnd.contentView.uid : "XX"));
        }
        pnd.viewInstanceIdx = instanceIdx;
        pnd.dataHolder = pnd.data = undefined;
        updateMode = true;
    }

    if (dynParamNames) {
        pnd.dynamicParams = {};
    }

    let parent = vNodes[parentIndex] as IvCptContainer | IvParamNode,
        data: any,
        dataName = name,
        prevData: any = undefined,
        dataHolder = parent.data;
    if (!dataHolder) {
        error(v, "Invalid parameter node <." + name + "/>: no param node can be used in this context"); // TODO error handling
    } else {
        // for (let k in dataHolder) console.log(" >>> ", k)
        pnd.dataHolder = dataHolder;
        if (pnd.dataIsList === undefined) {
            identifyPNodeList(v, pnd, dataName, dataHolder);
        }
        dataName = pnd.dataName; // changed by identifyPNodeList
        prevData = pnd.data;

        if (pnd.dataIsList) {
            // data node is a list item
            let parentLists = parent.lists;
            if (!parentLists) {
                // create the list meta data
                parentLists = parent.lists = {
                    sizes: {},      // dictionary of the temporary lists
                    listNames: [],  // name of the lists managed by the object holding this meta data - e.g. ["list1", "list2"]
                    listMap: {}     // map of the list names - e.g. {list1: 1, list2: 1}
                }
            }

            // register the param list in the parent
            if (!parentLists.listMap[dataName]) {
                parentLists.listMap[dataName] = 1;
                parentLists.listNames.push(dataName);
            }

            let size = parentLists.sizes[dataName];
            if (!size) {
                size = parentLists.sizes[dataName] = 0; // temporary array
            }

            // get an existing item from the current list or create one
            data = dataHolder[dataName][size];
            if (!data) {
                data = create(dataHolder[dataName], size);
            }
            parentLists.sizes[dataName] += 1;
            pnd.data = data;
        } else {
            // data node is not a list item
            pnd.data = data = dataHolder[dataName];
            if (data === undefined) {
                // create the property node
                pnd.data = data = create(dataHolder, dataName);
            }
        }

        if (updateMode && data) {
            if (data["ΔΔ$content"]) {
                pnd.contentView = data["ΔΔ$content"];
                // console.log(">>> ζpnode: retrieve contentView from data: " + (pnd.contentView ? pnd.contentView.uid : "XX"))
            }
        }
    }
    // note: data may not be defined if the param node is not associated to an object 
    // e.g. string or boolean or number that will be used with a $value param - cf. ζpar

    // if contains list params, reset the tempLists
    if (pnd.lists) {
        pnd.lists.sizes = {};
    }

    // if dynamic, flag the node as read
    let dp = (parent as IvCptContainer | IvParamNode).dynamicParams;
    if (dp) {
        dp[dataName] = 1;
    }

    if (staticParams) {
        if (!data) {
            // TODO: remove when @value is used instead of $value
            // error(v, "Invalid param node parameter: " + staticParams[0]);
        } else if (prevData !== data) {
            // initialize static params
            // prevData !== data is true when node data has been created or reset
            let len = staticParams.length;
            for (let i = 0; len > i; i += 2) {
                if (cm && !hasProperty(data, staticParams[i])) {
                    error(v, "Invalid param node parameter: " + staticParams[i]);
                }
                data[staticParams[i]] = staticParams[i + 1];
            }
        }
    }
}

function cleanDataLists(dataHolder: IvCptContainer | IvParamNode) {
    if (dataHolder.lists) {
        let lists = dataHolder.lists, lsNames = lists.listNames, nm: string, sz: number, data: any, len2: number;
        for (let i = 0; lsNames.length > i; i++) {
            nm = lsNames[i];
            sz = lists.sizes[nm] || 0;
            data = dataHolder.data[nm];
            len2 = data.length;
            if (sz < len2) {
                data.splice(sz, len2 - sz);
            }
        }
    }
}

export function ζpnEnd(v: IvView, cm: boolean, iFlag: number, idx: number, labels?: any[] | 0, dynParamNames?: string[]) {
    let pn = v.nodes![idx] as IvParamNode;

    cleanDataLists(pn);

    if (dynParamNames) {
        let len = dynParamNames.length, dp = pn.dynamicParams;
        for (let i = 0; len > i; i++) {
            if (dp && !dp[dynParamNames[i]]) {
                // this param node has not been called - so we need to reset it
                // console.log("reset", dynParamNames[i]);
                reset(pn.data, dynParamNames[i]);
            }
        }
    }
}

// Attribute setter
// e.g. ζatt(ζ, 0, 1, "title", ζe(ζ, 0, exp()+123));
export function ζatt(v: IvView, iFlag: number, eltIdx: number, name: string, expr: any) {
    if (expr === ζu) return;
    let val = getExprValue(v, iFlag, expr);
    if (val !== ζu) {
        (v.nodes![eltIdx] as IvNode).domNode.setAttribute(name, val);
    }
}

export function ζattD(v: IvView, iFlag: number, eltIdx: number, name: string, expr: any) {
    if (expr !== ζu) {
        addInstruction(v, ζatt, [v, iFlag, eltIdx, name, expr]);
    }
}

// Property setter
// e.g. ζpro(ζ, 0, 1, "title", ζe(ζ, 0, exp()+123));
export function ζpro(v: IvView, iFlag: number, eltIdx: number, name: string, expr: any) {
    if (expr === ζu) return;
    let val = getExprValue(v, iFlag, expr);
    if (val !== ζu) {
        (v.nodes![eltIdx] as IvNode).domNode[name] = val;
    }
}

export function ζproD(v: IvView, iFlag: number, eltIdx: number, name: string, expr: any) {
    if (expr !== ζu) {
        addInstruction(v, ζpro, [v, iFlag, eltIdx, name, expr]);
    }
}

// Param setter
// e.g. ζpar(ζ, 0, 1, "title", ζe(ζ, 0, exp()+123));
export function ζpar(v: IvView, cm: boolean, iFlag: number, eltIdx: number, name: string, expr: any) {
    if (expr === ζu) return;
    let val = getExprValue(v, iFlag, expr);

    if (val !== ζu) {
        let nd = v.nodes![eltIdx];
        if (nd.kind === "#container") {
            let p = (nd as IvCptContainer).data;
            if (p) {
                // console.log("1:set", name, "=", val, "in", p)
                if (cm && !hasProperty(p, name)) {
                    error(v, "Invalid parameter: " + name);
                }
                p[name] = val;
            } else {
                error(v, "Invalid parameter: " + name);
            }
        } else if (nd.kind === "#param") {
            let p = (nd as IvParamNode);
            if (name === "$value") {
                // console.log("previous:", p.dataParent[p.name], "new:", val, p.dataParent[p.name] !== val);
                p.dataHolder[p.dataName] = val;
            } else {
                if (!p.data) {
                    // could not be created in the ζpnode instruction => invalid parameter
                    error(v, "Invalid param node parameter: " + name);
                } else {
                    if (cm && !hasProperty(p.data, name)) {
                        error(v, "Invalid param node parameter: " + name);
                    }
                    p.data[name] = val;
                }
            }
        }
    }
}

export function ζparD(v: IvView, cm: boolean, iFlag: number, eltIdx: number, name: string, expr: any) {
    if (expr !== ζu) {
        let nd = v.nodes![eltIdx];
        if (nd.kind === "#param") {
            ζpar(v, cm, 0, eltIdx, name, expr);
        } else {
            addInstruction(v, ζpar, [v, cm, iFlag, eltIdx, name, expr]);
        }
    }
}

// Dynamic label
// e.g. ζlbl(ζ, 0, 0, "divA", expr());
export function ζlbl(v: IvView, iFlag: number, idx: number, name: string, value: any) {
    if (value && v.nodes) {
        let o = v.nodes[idx];
        if (o.kind === "#container" && (o as IvContainer).subKind === "##cpt") {
            let tpl = (o as IvCptContainer).template;
            if (tpl) {
                registerLabels(v, tpl.$api, [name]);
            }
        } else if (o.domNode) {
            registerLabels(v, o.domNode, [name]);
        }
    }
}

export function ζlblD(v: IvView, iFlag: number, idx: number, name: string, value: any) {
    if (value) {
        addInstruction(v, ζlbl, [v, iFlag, idx, name, 1]);
    }
}

// Event listener
// ζevt(ζ, ζc, 1, 0, function (e) {doSomething()});
export function ζevt(v: IvView, cm: boolean, idx: number, eltIdx: number, eventName: string, handler: (e: any) => void) {
    if (cm) {
        // get associated elt
        let domNode = v.nodes![eltIdx].domNode;
        if (!domNode) {
            console.log("[ERROR] Invalid ζevt call: parent element must have a DOM node");
            return;
        }
        // create and register event listener
        let nd: IvEltListener = {
            kind: "#listener",
            uid: "evt" + (++uidCount),
            idx: idx,
            parentIdx: eltIdx,
            nextSibling: undefined,
            domNode: domNode,
            attached: true,
            callback: handler
        }
        v.nodes![idx] = nd;
        domNode.addEventListener(eventName, function (evt: any) {
            if (nd.callback) {
                nd.callback(evt);
            }
        });
    } else {
        // update callback as it may contain different closure values
        (v.nodes![idx] as IvEltListener).callback = handler;
    }
}

export function ζevtD(v: IvView, cm: boolean, idx: number, eltIdx: number, eventName: string, handler: (e: any) => void) {
    addInstruction(v, ζevt, [v, cm, idx, eltIdx, eventName, handler]);
}

// Insert / Content projection instruction
// e.g. ζins(ζ, 1, ζe(ζ, 0, $content));
export function ζins(v: IvView, iFlag: number, idx: number, exprContentView: any) {
    let projectionNode = v.nodes![idx] as (IvElement | IvFragment); // node with @content decorator: either a fragment or an element
    let contentView = getExprValue(v, iFlag, exprContentView) as IvView;

    if ((contentView as any) === ζu || exprContentView === undefined) {
        contentView = projectionNode.contentView as IvView;
    }
    // console.log("ζins", contentView ? contentView.uid : "no content view");

    if (!contentView) return;
    // logView(contentView, "insert: " + contentView.uid);

    let ph = contentView.projectionHost;
    if (ph && ph.hostNode !== projectionNode) {
        // contentView was already projected somewhere else
        removeFromDom(contentView, contentView.nodes![0]);
    }

    if (projectionNode.contentView && projectionNode.contentView !== contentView) {
        console.log("TODO: check once param nodes are available");
        // current projection node is already projecting a view
        removeFromDom(projectionNode.contentView, projectionNode.contentView.nodes![0]);
    }
    projectionNode.contentView = contentView;
    contentView.projectionHost = {
        view: v,
        hostNode: projectionNode
    }

    if (contentView.cm) {
        if (projectionNode.kind === "#element") {
            let pdn = projectionNode.domNode;
            contentView.cmAppends = [function (n: IvNode) {
                // console.log("cmAppends #5", n.uid, n.domNode ? n.domNode.uid : "XX");
                if (n.domNode) {
                    projectionNode.domNode.appendChild(n.domNode);
                } else {
                    n.domNode = pdn;
                }
            }];
        } else {
            // fragment
            contentView.cmAppends = [getViewInsertFunction(v, projectionNode)]
        }
    } else {
        let insertFn: ((n: IvNode, domOnly: boolean) => void);
        // insert 
        if (projectionNode.kind === "#element") {
            let elt = projectionNode.domNode
            insertFn = function (n: IvNode, domOnly: boolean) {
                if (n.domNode) {
                    elt.appendChild(n.domNode);
                } else {
                    n.domNode = elt;
                }
            }
        } else {
            // fragment
            insertFn = getViewInsertFunction(v, projectionNode as IvFragment);
        }
        insertInDom(contentView.nodes![0], insertFn, 3);
    }

    contentView.container = projectionNode;
    runInstructions(contentView);
    // logView(contentView, "insert complete: " + contentView.uid);
}

export function ζinsD(v: IvView, iFlag: number, idx: number, exprContentView: any) {
    addInstruction(v, ζins, [v, iFlag, idx, exprContentView]);
}

interface SiblingDomPosition {
    position: "lastChild" | "beforeChild" | "lastOnRoot" | "defer";
    nextDomNd?: any;
    parentDomNd: any;
}

function findNextSiblingDomNd(v: IvView, nd: IvNode): SiblingDomPosition {
    while (true) {
        if (!nd) {
            error(v, "Internal error - findNextSiblingDomNd: nd cannot be undefined");
        }
        // console.log("findNextSiblingDomNd", nd.uid)
        if (nd.idx === 0) {
            // console.log("> is root - is attached:", nd.attached)
            if (!nd.attached) {
                return { position: "defer", parentDomNd: undefined };
            }
            // root node has no sibling
            let pView = v.parentView;
            if (!pView) {
                return { position: "lastOnRoot", parentDomNd: v.rootDomNode, nextDomNd: v.anchorNode };
            } else {
                if (v.projectionHost) {
                    // current node is the root of a light-dom that is projected in another container
                    let container = v.projectionHost.hostNode;
                    if (container.kind === "#element") {
                        return { position: "lastChild", parentDomNd: container.domNode };
                    } else {
                        // container is a fragment
                        return findNextSiblingDomNd(v.projectionHost.view, container);
                    }
                } else {
                    return findNextSiblingDomNd(pView, v.container as IvNode);
                }
            }
        }

        // find next node that is attached
        if (nd.nextSibling) {
            // console.log("> is not last")
            let sdp = findFirstDomNd(v, nd.nextSibling, getParentDomNd(v, nd));
            if (sdp) return sdp;
            // if not found (e.g. node not attached) we shift by 1
            nd = nd.nextSibling;
        } else {
            // console.log("> is last")
            // nd is last sibling
            let parent = v.nodes![nd.parentIdx] as IvParentNode;
            if (parent.kind === "#element") {
                return { position: "lastChild", parentDomNd: getParentDomNd(v, nd) };
            }
            // parent is a fragment (or variant)
            return findNextSiblingDomNd(v, parent);
        }
    }

    function findFirstDomNd(v: IvView, nd: IvNode, parentDomNd: any): SiblingDomPosition | null {
        // console.log("findFirstDomNd", nd? nd.uid : "XX")
        if (!nd) return null;
        if (nd.kind === "#element" || nd.kind === "#text") {
            return { position: "beforeChild", nextDomNd: nd.domNode, parentDomNd: parentDomNd };
        } else if (nd.kind === "#fragment") {
            let sdp: SiblingDomPosition | null, ch = (nd as IvParentNode).firstChild;
            while (ch) {
                sdp = findFirstDomNd(v, ch, parentDomNd);
                if (sdp) {
                    return sdp;
                }
                ch = ch.nextSibling!;
            }
            if ((nd as IvFragment).contentView) {
                // Search in projected view
                let cv = (nd as IvFragment).contentView!;
                if (cv.nodes) return findFirstDomNd(cv, cv.nodes[0], parentDomNd);
            }
            // not found
            return null;
        } else if (nd.kind === "#container") {
            let container = nd as IvContainer, sdp: SiblingDomPosition | null = null;
            if (container.subKind === "##block") {
                let views = (container as IvBlockContainer).views, len = views.length;
                for (let i = 0; len > i; i++) {
                    sdp = findFirstDomNd(views[i], views[i].nodes![0] as IvNode, parentDomNd);
                    if (sdp) break;
                }
            } else if (container.subKind === "##cpt") {
                let tpl = (container as IvCptContainer).template as Template, view = tpl.view;
                sdp = findFirstDomNd(view, view.nodes![0], parentDomNd);
            }
            return sdp ? sdp : null;
        } else {
            throw new Error("TODO findFirstDomNd: " + nd.kind); // e.g. #decorator
        }
    }
}

function getParentDomNd(v: IvView, nd: IvNode) {
    // console.log("getParentDomNd", v.uid, nd ? nd.uid : "XX");

    if (nd.idx === 0 && v.projectionHost) {
        // this node is a light-dom root node
        if (!nd.attached) return null;
        let hNode = v.projectionHost.hostNode;
        if (hNode.kind === "#element") {
            return hNode.domNode;
        } else {
            // hNode is a fragment
            return getParentDomNd(v.projectionHost.view, hNode);
        }
    }
    if (nd.idx === 0) {
        // nd is a root node
        if (v.parentView) {
            return getParentDomNd(v.parentView, v.container as IvNode);
        } else {
            return v.rootDomNode;
        }
    }
    return (v.nodes![nd.parentIdx] as IvNode).domNode;
}

function removeFromDom(v: IvView, nd: IvNode) {
    if (!nd || !nd.attached) return;
    // console.log("removeFromDom", nd.uid);
    if (nd.kind === "#text" || nd.kind === "#element") {
        let pdn = getParentDomNd(v, nd);
        nd.attached = false;
        if (pdn) {
            // console.log("removeChild:", nd.domNode.uid, "in", pdn ? pdn.uid : "XX")
            pdn.removeChild(nd.domNode);
        } else {
            error(v, "Internal error - parent not found for: " + nd.uid);
        }
    } else if (nd.kind === "#container") {
        if (nd["subKind"] === "##block") {
            let container = nd as IvBlockContainer;
            let views = container.views, len = views.length, root: IvNode;
            // remove all blocks from dom and put them in blockPool
            for (let i = 0; len > i; i++) {
                root = views[i].nodes![0];
                removeFromDom(views[i], root);
                root.attached = false;
                if (root.kind === "#container" || root.kind === "#fragment") {
                    root.domNode = undefined;
                }
            }
            // move previous nodes to blockPool
            container.views = [];
            container.previousNbrOfViews = 0;
            container.viewPool = views.concat(container.viewPool);
        } else if (nd["subKind"] === "##cpt") {
            let tpl = (nd as IvCptContainer).template as Template
            let nodes = tpl.view.nodes!, root = nodes[0];
            removeFromDom(tpl.view, root);
            root.attached = false;
            if (root.kind === "#container" || root.kind === "#fragment") {
                root.domNode = undefined;
            }
        }
        // note: we have to keep container attached (except if they are root)
    } else if (nd.kind === "#fragment") {
        let f = nd as IvFragment;
        f.attached = false;
        if (f.contentView) {
            removeFromDom(f.contentView, f.contentView.nodes![0]);
        } else
            if (f.firstChild) {
                let nd = f.firstChild;
                while (nd) {
                    removeFromDom(v, nd);
                    nd = nd.nextSibling!;
                }
            }
        f.domNode = undefined;
    } else if (nd.kind === "#param") {
        console.warn("TODO removeFromDom for param nodes")
    } else {
        // will raise an error when new node types are introduced
        console.warn("RemoveFromDom for " + nd.kind)
    }
}

// ----------------------------------------------------------------------------------------------
// Param class

export const ζΔD = ΔD;
export const ζΔp = Δp;
export const ζΔf = Δf;
export const ζΔfStr = ΔfStr;
export const ζΔfBool = ΔfBool;
export const ζΔfNbr = ΔfNbr;
export const ζΔlf = Δlf;
export const ζΔu = Δu;
export const Controller = ΔD;
export const API = ΔD;

// ----------------------------------------------------------------------------------------------
// Async functions

export async function asyncComplete() {
    return null; //createAsyncProcessor();
}

// ----------------------------------------------------------------------------------------------
// Debug function

const SEP = "-------------------------------------------------------------------------------";

function logView(v: IvView, label = "", viewId?: string) {
    if (!viewId || v.uid === viewId) {
        console.log("");
        console.log(SEP);
        if (label) {
            console.log(label + ":")
        }
        logViewNodes(v);
    }
}

function logViewDom(v: IvView) {
    // only works with test dom nodes
    if (!v || !v.nodes) {
        console.log("No nodes");
    } else if (!v.nodes![0].domNode) {
        console.log("No DOM node");
    } else if (!v.nodes![0].domNode.stringify) {
        console.log("DOM node doesn't support stringify");
    } else {
        console.log(v.nodes![0].domNode!.stringify());
    }
}

export function logViewNodes(v: IvView, indent: string = "") {
    if (!v.nodes) {
        console.log(`${indent}${v.uid} - no nodes`);
        return;
    }
    let pv = v.parentView ? v.parentView.uid : "XX", ph = v.projectionHost, host = ph ? " >>> projection host: " + ph.hostNode.uid + " in " + ph.view.uid : "";
    console.log(`${indent}*${v.uid}* cm:${v.cm} isTemplate:${v.template !== undefined} parentView:${pv}${host}`);
    let len = v.nodes.length, nd: IvNode, space = "";
    for (let i = 0; len > i; i++) {
        nd = v.nodes[i];
        if (!nd) {
            console.log(`${indent}[${i}] XX`)
            continue;
        }

        if (nd.uid.length < 5) {
            space = ["     ", "    ", "   ", "  ", " "][nd.uid.length];
        } else {
            space = "";
        }
        if (nd.kind === "#container") {
            let cont = nd as IvContainer;
            let dn = cont.domNode ? cont.domNode.uid : "XX";
            console.log(`${indent}[${i}] ${nd.uid}${space} ${dn} attached:${nd.attached ? 1 : 0} parent:${parent(nd.parentIdx)} nextSibling:${nd.nextSibling ? nd.nextSibling.uid : "X"}`);
            if (cont.subKind === "##block") {
                let cb = cont as IvBlockContainer, len2 = cb.views.length;
                if (!len2) {
                    console.log(`${indent + "  "}- no child views`);
                } else {
                    for (let j = 0; len2 > j; j++) {
                        if (!cb.views[j]) {
                            console.log(`${indent + "  "}- view #${j} UNDEFINED`);
                            continue;
                        }
                        let childView = cb.views[j];
                        dn = childView.rootDomNode ? childView.rootDomNode.$uid : "XX";
                        console.log(`${indent + "  "}- view #${j}`);
                        logViewNodes(cb.views[j], "    " + indent);
                    }
                }
            } else if (cont.subKind === "##cpt") {
                let cc = cont as IvCptContainer, tpl = cc.template, contentView = cc.contentView;
                if (!contentView) {
                    console.log(`${indent + "  "}- light DOM: none`);
                } else {
                    console.log(`${indent + "  "}- light DOM:`);
                    logViewNodes(contentView, "    " + indent);
                }
                if (!tpl) {
                    console.log(`${indent + "  "}- no template`);
                } else {
                    console.log(`${indent + "  "}- shadow DOM:`);
                    logViewNodes(tpl["view"], "    " + indent);
                }
            } else {
                console.log(`${indent + "  "}- ${cont.subKind} container`);
            }
        } else {
            let dn = nd.domNode ? nd.domNode.uid : "XX", lastArg = "";
            if (nd.domNode && nd.kind === "#text") {
                lastArg = " text=#" + nd.domNode["_textContent"] + "#";
            } else if (nd.kind === "#fragment" || nd.kind === "#element") {
                let children: string[] = [], ch = (nd as IvFragment).firstChild;
                while (ch) {
                    children.push(ch.uid);
                    ch = ch.nextSibling;
                }
                lastArg = " children:[" + children.join(", ") + "]";
                let cnView = (nd as IvFragment | IvElement).contentView;
                if (cnView) {
                    lastArg += " >>> content view: " + cnView.uid;
                }
            }
            console.log(`${indent}[${nd.idx}] ${nd.uid}${space} ${dn} attached:${nd.attached ? 1 : 0} parent:${parent(nd.parentIdx)} nextSibling:${nd.nextSibling ? nd.nextSibling.uid : "X"}${lastArg}`);
        }
    }

    function parent(idx) {
        return idx < 0 ? "X" : idx;
    }
}