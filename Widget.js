define([
	"require", // require.toUrl
	"dcl/dcl",
	"dojo/aspect",
	"dojo/Deferred",
	"dojo/dom", // dom.byId
	"dojo/dom-class", // domClass.add domClass.replace
	"dojo/dom-construct", // domConstruct.destroy domConstruct.place
	"dojo/dom-geometry", // isBodyLtr
	"dojo/dom-style", // domStyle.set, domStyle.get
	"dojo/has",
	"dojo/_base/lang", // mixin(), hitch(), etc.
	"dojo/on",
	"./Destroyable",
	"./Stateful",
	"./register",
	"dojo/has!dojo-bidi?./Bidi"
], function (require, dcl, aspect, Deferred, dom, domClass, domConstruct, domGeometry, domStyle,
			 has, lang, on, Destroyable, Stateful, register, Bidi) {

	// module:
	//		delite/Widget

	// Flag to enable support for textdir attribute
	has.add("dojo-bidi", false);

	var div = document.createElement("div");

	var Widget = dcl([Stateful, Destroyable], {
		// summary:
		//		Base class for all widgets.
		//
		//		Provides stubs for widget lifecycle methods for subclasses to extend, like  buildRendering(),
		//		postCreate(), startup(), and destroy(), and also public API methods like watch().
		//
		//		Widgets can provide custom setters/getters for widget attributes, which are called automatically
		//		by set(name, value).  For an attribute XXX, define methods _setXXXAttr() and/or _getXXXAttr().

		// baseClass: [protected] String
		//		Root CSS class of the widget (ex: d-text-box)
		baseClass: "",
		_setBaseClassAttr: function (value) {
			domClass.replace(this, value, this.baseClass);
			this._set("baseClass", value);
		},

		// focused: [readonly] Boolean
		//		This widget or a widget it contains has focus, or is "active" because
		//		it was recently clicked.
		focused: false,

		/*=====
		 // containerNode: [readonly] DomNode
		 //		Designates where children of the source DOM node will be placed.
		 //		"Children" in this case refers to both DOM nodes and widgets.
		 //
		 //		containerNode must be defined for any widget that accepts innerHTML
		 //		(like ContentPane or BorderContainer or even Button), and conversely
		 //		is undefined for widgets that don't, like TextBox.
		 containerNode: undefined,

		 // _started: [readonly] Boolean
		 //		startup() has completed.
		 _started: false,
		 =====*/

		// register: delite/register
		//		Convenience pointer to register class.   Used by buildRendering() functions produced from
		//		handlebars! / template.
		register: register,

		_getProps: function () {
			// Override _Stateful._getProps() to ignore properties from the HTML*Element superclasses, like "style".
			// You would need to explicitly declare style: "" in your widget to get it here.
			// Intentionally skips privates and methods, because it seems wasteful to have a custom
			// setter for every method; not sure that would work anyway.
			//
			// Also sets up this._propCaseMap, a mapping from lowercase property name to actual name,
			// ex: iconclass --> iconClass, which does include the methods, but again doesn't
			// include props like "style" that are merely inherited from HTMLElement.

			var list = [], proto = this, ctor,
				pcm = this._propCaseMap = {};

			do {
				Object.keys(proto).forEach(function (prop) {
					if (!/^_/.test(prop)) {
						if (typeof proto[prop] !== "function") {
							list.push(prop);
						}
						pcm[prop.toLowerCase()] = prop;
					}
				});

				proto = Object.getPrototypeOf(proto);
				ctor = proto && proto.constructor;
			} while (proto && ctor !== this._baseElement);

			return list;
		},

		//////////// INITIALIZATION METHODS ///////////////////////////////////////

		createdCallback: function () {
			// summary:
			//		Kick off the life-cycle of a widget
			// description:
			//		Create calls a number of widget methods (buildRendering, postCreate,
			//		etc.), some of which of you'll want to override.
			//
			//		Of course, adventurous developers could override create entirely, but this should
			//		only be done as a last resort.
			// params: Object|null
			//		Hash of initialization parameters for widget, including scalar values (like title, duration etc.)
			//		and functions, typically callbacks like onClick.
			//		The hash can contain any of the widget's properties, excluding read-only properties.
			// tags:
			//		private

			// Get parameters that were specified declaratively on the widget DOMNode.
			var params = this.mapAttributes();

			this.preCreate();

			// Render the widget
			this.buildRendering();

			this.postCreate();

			this._created = true;

			// Now that creation has finished, apply parameters that were specified declaratively.
			// This is consistent with the timing that parameters are applied for programmatic creation.
			dcl.mix(this, params);
		},

		enteredViewCallback: function () {
			// summary:
			//		Called when the widget is first inserted into the document.
			//		If widget is created programatically then app must call startup() to trigger this method.

			this._enteredView = true;

			// When Widget extends Invalidating some/all of this code should probably be moved to refreshRendering()

			if (this.baseClass) {
				domClass.add(this, this.baseClass);
			}
			if (!this.isLeftToRight()) {
				domClass.add(this, "d-rtl");
			}

			// Since safari masks all custom setters for tabIndex on the prototype, call them here manually.
			// For details see:
			//		https://bugs.webkit.org/show_bug.cgi?id=36423
			//		https://bugs.webkit.org/show_bug.cgi?id=49739
			//		https://bugs.webkit.org/show_bug.cgi?id=75297
			var tabIndex = this.tabIndex;
			// Trace up prototype chain looking for custom setter
			for (var proto = this; proto; proto = Object.getPrototypeOf(proto)) {
				var desc = Object.getOwnPropertyDescriptor(proto, "tabIndex");
				if (desc && desc.set) {
					if (this.hasAttribute("tabindex")) { // initial value was specified
						this.removeAttribute("tabindex");
						desc.set.call(this, tabIndex); // call custom setter
					}
					var self = this;
					// begin watching for changes to the tabindex DOM attribute
					/* global WebKitMutationObserver */
					if ("WebKitMutationObserver" in window) {
						// If Polymer is loaded, use MutationObserver rather than WebKitMutationObserver
						// to avoid error about "referencing a Node in a context where it does not exist".
						var MO = window.MutationObserver || WebKitMutationObserver;	// for jshint
						var observer = new MO(function () {
							var newValue = self.getAttribute("tabindex");
							if (newValue !== null) {
								self.removeAttribute("tabindex");
								desc.set.call(self, newValue);
							}
						});
						observer.observe(this, {
							subtree: false,
							attributeFilter: ["tabindex"],
							attributes: true
						});
					}
					break;
				}
			}
		},

		/**
		 * Get declaratively specified attributes to widget properties
		 */
		mapAttributes: function () {
			var pcm = this._propCaseMap,
				attr,
				idx = 0,
				props = {};

			// inner functions useful to reduce cyclomatic complexity when using jshint
			function stringToObject(value) {
				var obj;

				try {
					// TODO: remove this code if it isn't being used, so we don't scare people that are afraid of eval.
					/* jshint evil:true */
					// This will only be executed when complex parameters are used in markup
					// <my-tag constraints="max: 3, min: 2"></my-tag>
					// This can be avoided by using such complex parameters only programmatically or by not using
					// them at all.
					// This is harmless if you make sure the JavaScript code that is passed to the attribute
					// is harmless.
					obj = eval("(" + (value[0] === "{" ? "" : "{") + value + (value[0] === "{" ? "" : "}") + ")");
				}
				catch (e) {
					throw new SyntaxError("Error in attribute conversion to object: " + e.message +
						"\nAttribute Value: '" + value + "'");
				}
				return obj;
			}

			function setTypedValue(widget, name, value) {
				switch (typeof widget[name]) {
				case "string":
					props[name] = value;
					break;
				case "number":
					props[name] = value - 0;
					break;
				case "boolean":
					props[name] = value !== "false";
					break;
				case "object":
					var obj = lang.getObject(value, false);
					if (obj) {
						// it's a global, ex: store="myStore"
						props[name] = obj;
					} else {
						// it's an expression, ex: constraints="min: 10, max: 100"
						props[name] = (widget[name] instanceof Array)
							? (value
							? value.split(/\s+/)
							: [])
							: stringToObject(value);
					}
					break;
				case "function":
					/* jshint evil:true */
					// This will only be executed if you have properties that are of function type if your widget
					// and that you set them in your tag attributes:
					// <my-tag whatever="myfunc"></my-tag>
					// This can be avoided by setting the function progammatically or by not setting it at all.
					// This is harmless if you make sure the JavaScript code that is passed to the attribute
					// is harmless.
					props[name] = lang.getObject(value, false) || new Function(value);
				}
				delete widget[name]; // make sure custom setters fire
			}

			var attrsToRemove = [];
			while ((attr = this.attributes[idx++])) {
				// Map all attributes except for things like onclick="..." since the browser already handles them.
				var name = attr.name.toLowerCase();	// note: will be lower case already except for IE9
				if (name in pcm) {
					setTypedValue(this, pcm[name]/* convert to correct case for widget */, attr.value);
					attrsToRemove.push(name);
				}
			}

			// Remove attributes that were processed, but do it in a separate loop so we don't modify this.attributes
			// while we are looping through it.   (See Widget-attr.html test failure on IE10.)
			attrsToRemove.forEach(this.removeAttribute, this);

			return props;
		},

		preCreate: function () {
			// summary:
			//		Processing before buildRendering()
			// tags:
			//		protected

			// FF has a native watch() method that overrides our Stateful.watch() method and breaks custom setters,
			// so that any command like this.label = "hello" sets label to undefined instead.  Try to workaround.
			this.watch = Stateful.prototype.watch;
		},

		buildRendering: function () {
			// summary:
			//		Construct the UI for this widget, filling in subnodes and/or text inside of this.
			//		Most widgets will leverage delite/handlebars! to implement this method.
			// tags:
			//		protected
		},

		postCreate: function () {
			// summary:
			//		Processing after the DOM fragment is created
			// description:
			//		Called after the DOM fragment has been created, but not necessarily
			//		added to the document.  Do not include any operations which rely on
			//		node dimensions or placement.
			// tags:
			//		protected
		},

		startup: function () {
			// summary:
			//		Processing after the DOM fragment is added to the document
			// description:
			//		Called after a widget and its children have been created and added to the page,
			//		and all related widgets have finished their create() cycle, up through postCreate().
			//
			//		Note that startup() may be called while the widget is still hidden, for example if the widget is
			//		inside a hidden deliteful/Dialog or an unselected tab of a deliteful/TabContainer.
			//		For widgets that need to do layout, it's best to put that layout code inside resize(), and then
			//		extend delite/_LayoutWidget so that resize() is called when the widget is visible.

			if (this._started) {
				return;
			}

			if (!this._enteredView) {
				this.enteredViewCallback();
			}

			this._started = true;
			this.getChildren().forEach(function (obj) {
				if (!obj._started && !obj._destroyed && typeof obj.startup == "function") {
					obj.startup();
					obj._started = true;
				}
			});
		},

		//////////// DESTROY FUNCTIONS ////////////////////////////////
		destroy: function (/*Boolean*/ preserveDom) {
			// summary:
			//		Destroy this widget and its descendants.
			// preserveDom: Boolean
			//		If true, this method will leave the original DOM structure alone.

			this._beingDestroyed = true;

			// Destroy child widgets
			this.findWidgets(this).forEach(function (w) {
				if (w.destroy) {
					w.destroy();
				}
			});

			// Destroy this widget
			this.destroyRendering(preserveDom);
			this._destroyed = true;
		},

		destroyRendering: function (/*Boolean?*/ preserveDom) {
			// summary:
			//		Destroys the DOM nodes associated with this widget.
			// preserveDom:
			//		If true, this method will leave the original DOM structure alone
			//		during tear-down. Note: this will not work with _Templated
			//		widgets yet.
			// tags:
			//		protected

			if (this.bgIframe) {
				this.bgIframe.destroy(preserveDom);
				delete this.bgIframe;
			}

			if (!preserveDom) {
				domConstruct.destroy(this);
			}
		},

		emit: function (/*String*/ type, /*Object?*/ eventObj) {
			// summary:
			//		Used by widgets to signal that a synthetic event occurred, ex:
			//	|	myWidget.emit("attrmodified-selectedChildWidget", {}).
			//
			//		Emits an event of specified type, based on eventObj.
			//		Also calls onType() method, if present, and returns value from that method.
			//		Modifies eventObj by adding missing parameters (bubbles, cancelable, widget).
			// tags:
			//		protected

			// Specify fallback values for bubbles, cancelable in case they are not set in eventObj.
			// Also set pointer to widget, although since we can't add a pointer to the widget for native events
			// (see #14729), maybe we shouldn't do it here?
			eventObj = eventObj || {};
			if (eventObj.bubbles === undefined) {
				eventObj.bubbles = true;
			}
			if (eventObj.cancelable === undefined) {
				eventObj.cancelable = true;
			}

			// Emit event, but avoid spurious emit()'s as parent sets properties on child during startup/destroy
			if (this._started && !this._beingDestroyed) {
				// Call onType() method if one exists.   But skip functions like onchange and onclick
				// because the browser will call them automatically when the event is emitted.
				var ret, callback = this["on" + type];
				if (callback && !("on" + type.toLowerCase() in div)) {
					ret = callback.call(this, eventObj);
				}

				// Emit the event
				on.emit(this, type, eventObj);
			}

			return ret;
		},

		on: function (/*String|Function*/ type, /*Function*/ func) {
			// summary:
			//		Call specified function when event occurs, ex: myWidget.on("click", function () { ... }).
			// type:
			//		Name of event (ex: "click") or extension event like touch.press.
			// description:
			//		Call specified function when event `type` occurs, ex: `myWidget.on("click", function () { ... })`.
			//		Note that the function is not run in any particular scope, so if (for example) you want it to run
			//		in the widget's scope you must do `myWidget.on("click", myWidget.func.bind(myWidget))`.

			return this.own(on(this, type, func))[0];
		},

		toString: function () {
			// summary:
			//		Returns a string that represents the widget.
			// description:
			//		When a widget is cast to a string, this method will be used to generate the
			//		output. Currently, it does not implement any sort of reversible
			//		serialization.
			return "[Widget " + this.nodeName.toLowerCase() + ", " + (this.id || "NO ID") + "]"; // String
		},

		getChildren: function () {
			// summary:
			//		Returns all direct children of this widget, i.e. all widgets or DOM node underneath
			//		this.containerNode whose parent is this widget.  Note that it does not return all
			//		descendants, but rather just direct children.
			//
			//		The result intentionally excludes internally created widgets (a.k.a. supporting widgets)
			//		outside of this.containerNode.

			// use Array.prototype.slice to transform the live HTMLCollection into an Array
			return this.containerNode ? Array.prototype.slice.call(this.containerNode.children) : []; // []
		},

		getParent: function () {
			// summary:
			//		Returns the parent widget of this widget.

			return this.getEnclosingWidget(this.parentNode);
		},

		isLeftToRight: function () {
			// summary:
			//		Return this widget's explicit or implicit orientation (true for LTR, false for RTL)
			// tags:
			//		protected
			return this.dir ? (this.dir === "ltr") : domGeometry.isBodyLtr(this.ownerDocument); //Boolean
		},

		isFocusable: function () {
			// summary:
			//		Return true if this widget can currently be focused
			//		and false if not
			return this.focus && (domStyle.get(this, "display") !== "none");
		},

		placeAt: function (/* String|DomNode|Widget */ reference, /* String|Int? */ position) {
			// summary:
			//		Place this widget somewhere in the DOM based
			//		on standard domConstruct.place() conventions.
			// description:
			//		A convenience function provided in all _Widgets, providing a simple
			//		shorthand mechanism to put an existing (or newly created) Widget
			//		somewhere in the dom, and allow chaining.
			// reference:
			//		Widget, DOMNode, or id of widget or DOMNode
			// position:
			//		If reference is a widget (or id of widget), and that widget has an ".addChild" method,
			//		it will be called passing this widget instance into that method, supplying the optional
			//		position index passed.  In this case position (if specified) should be an integer.
			//
			//		If reference is a DOMNode (or id matching a DOMNode but not a widget),
			//		the position argument can be a numeric index or a string
			//		"first", "last", "before", or "after", same as dojo/dom-construct::place().
			// returns: delite/Widget
			//		Provides a useful return of the newly created delite/Widget instance so you
			//		can "chain" this function by instantiating, placing, then saving the return value
			//		to a variable.
			// example:
			//	|	// create a Button with no srcNodeRef, and place it in the body:
			//	|	var button = new Button({ label:"click" }).placeAt(document.body);
			//	|	// now, 'button' is still the widget reference to the newly created button
			//	|	button.on("click", function (e) { console.log('click'); }));
			// example:
			//	|	// create a button out of a node with id="src" and append it to id="wrapper":
			//	|	var button = new Button({},"src").placeAt("wrapper");
			// example:
			//	|	// place a new button as the first element of some div
			//	|	var button = new Button({ label:"click" }).placeAt("wrapper","first");
			// example:
			//	|	// create a contentpane and add it to a TabContainer
			//	|	var tc = document.getElementById("myTabs");
			//	|	new ContentPane({ href:"foo.html", title:"Wow!" }).placeAt(tc)

			reference = dom.byId(reference);

			if (reference && reference.addChild && (!position || typeof position === "number")) {
				// Use addChild() if available because it skips over text nodes and comments.
				reference.addChild(this, position);
			} else {
				// "reference" is a plain DOMNode, or we can't use refWidget.addChild().   Use domConstruct.place() and
				// target refWidget.containerNode for nested placement (position==number, "first", "last", "only"), and
				// refWidget otherwise ("after"/"before"/"replace").
				var ref = reference ?
					(reference.containerNode && !/after|before|replace/.test(position || "") ?
						reference.containerNode : reference) : dom.byId(reference, this.ownerDocument);
				domConstruct.place(this, ref, position);

				// Start this iff it has a parent widget that's already started.
				// TODO: for 2.0 maybe it should also start the widget when this.getParent() returns null??
				if (!this._started && (this.getParent() || {})._started) {
					this.startup();
				}
			}
			return this;
		},

		defer: function (fcn, delay) {
			// summary:
			//		Wrapper to setTimeout to avoid deferred functions executing
			//		after the originating widget has been destroyed.
			//		Returns an object handle with a remove method (that returns null) (replaces clearTimeout).
			// fcn: Function
			//		Function reference.
			// delay: Number?
			//		Delay, defaults to 0.
			// tags:
			//		protected

			var timer = setTimeout(
				(function () {
					if (!timer) {
						return;
					}
					timer = null;
					if (!this._destroyed) {
						lang.hitch(this, fcn)();
					}
				}).bind(this),
				delay || 0
			);
			return {
				remove: function () {
					if (timer) {
						clearTimeout(timer);
						timer = null;
					}
					return null; // so this works well: handle = handle.remove();
				}
			};
		},

		// Utility functions previously in registry.js

		findWidgets: function (root) {
			// summary:
			//		Search subtree under root returning widgets found.
			//		Doesn't search for nested widgets (ie: widgets inside other widgets).
			// root: DOMNode
			//		Node to search under.

			var outAry = [];

			function getChildrenHelper(root) {
				for (var node = root.firstChild; node; node = node.nextSibling) {
					if (node.nodeType === 1 && node.buildRendering) {
						outAry.push(node);
					} else {
						getChildrenHelper(node);
					}
				}
			}

			getChildrenHelper(root || this.ownerDocument.body);
			return outAry;
		},

		getEnclosingWidget: function (/*DOMNode*/ node) {
			// summary:
			//		Returns the widget whose DOM tree contains the specified DOMNode, or null if
			//		the node is not contained within the DOM tree of any widget
			do {
				if (node.nodeType === 1 && node.buildRendering) {
					return node;
				}
			} while ((node = node.parentNode));
			return null;
		},

		// Focus related methods.  Used by focus.js.
		onFocus: function () {
			// summary:
			//		Called when the widget becomes "active" because
			//		it or a widget inside of it either has focus, or has recently
			//		been clicked.
			// tags:
			//		callback
		},

		onBlur: function () {
			// summary:
			//		Called when the widget stops being "active" because
			//		focus moved to something outside of it, or the user
			//		clicked somewhere outside of it, or the widget was
			//		hidden.
			// tags:
			//		callback
		},

		_onFocus: function () {
			// summary:
			//		This is where widgets do processing for when they are active,
			//		such as changing CSS classes.  See onFocus() for more details.
			// tags:
			//		protected
			this.onFocus();
		},

		_onBlur: function () {
			// summary:
			//		This is where widgets do processing for when they stop being active,
			//		such as changing CSS classes.  See onBlur() for more details.
			// tags:
			//		protected
			this.onBlur();
		}
	});

	if (has("dojo-bidi")) {
		Widget = dcl(Widget, Bidi);
	}

	// Setup automatic chaining for lifecycle methods, except for buildRendering()
	dcl.chainAfter(Widget, "preCreate");
	dcl.chainAfter(Widget, "postCreate");
	dcl.chainAfter(Widget, "startup");
	dcl.chainBefore(Widget, "destroy");

	return Widget;
});
