// Copyright (C) 2013:
//    Alex Russell <slightlyoff@chromium.org>
//    Yehua Katz
//
// Use of this source code is governed by
//    http://www.apache.org/licenses/LICENSE-2.0

// FIXME(slightlyoff):
//    - Document "npm test"
//    - Change global name from "Future" to something less conflicty
(function(global, browserGlobal) {
"use strict";

// Borrowed from RSVP.js
var async;

var MutationObserver = browserGlobal.MutationObserver ||
                       browserGlobal.WebKitMutationObserver;
var Future;

if (typeof process !== 'undefined' &&
  {}.toString.call(process) === '[object process]') {
  async = function(callback, binding) {
    process.nextTick(function() {
      callback.call(binding);
    });
  };
} else if (MutationObserver) {
  var queue = [];

  var observer = new MutationObserver(function() {
    var toProcess = queue.slice();
    queue = [];

    toProcess.forEach(function(tuple) {
      var callback = tuple[0], binding = tuple[1];
      callback.call(binding);
    });
  });

  var element = document.createElement('div');
  observer.observe(element, { attributes: true });

  // Chrome Memory Leak: https://bugs.webkit.org/show_bug.cgi?id=93661
  window.addEventListener('unload', function(){
    observer.disconnect();
    observer = null;
  });

  async = function(callback, binding) {
    queue.push([callback, binding]);
    element.setAttribute('drainQueue', 'drainQueue');
  };
} else {
  async = function(callback, binding) {
    setTimeout(function() {
      callback.call(binding);
    }, 1);
  };
}

// defineProperties utilities
var _readOnlyProperty = function(v) {
    return {
      enumerable: true,
      configurable: false,
      get: v
    };
};

var _method = function(v, e, c, w) {
    return {
      enumerable:   !!(e || 0),
      configurable: !!(c || 1),
      writable:     !!(w || 1),
      value:           v || function() {}
    };
};

var _pseudoPrivate = function(v) { return _method(v, 0, 1, 0); };
var _public = function(v) { return _method(v, 1); };

var isThenable = function(it) {
  // FIXME(slightlyoff): need a better/standard definition!
  var thenable = (
    !!it &&
    (typeof it.then == "function")
  );
  return thenable;
};

var AlreadyResolved = function(name) {
  Error.call(this, name);
};
AlreadyResolved.prototype = Object.create(Error.prototype);

var Backlog = function() {
  var bl = [];
  bl.pump = function(value) {
    async(function() {
      var l = bl.length;
      var x = 0;
      while(x < l) {
        x++;
        bl.shift()(value);
      }
    });
  };
  return bl;
};

var Resolver = function(future,
                        acceptCallbacks,
                        rejectCallbacks,
                        setValue,
                        setError,
                        setState) {
  var isResolved = false;
  var assertUnresolved = function() {
    if (isResolved) {
      throw new AlreadyResolved("Already Resolved");
    }
  };
  var resolver = this;

  // Indirectly resolves the Future, chaining any passed Future's resolution
  this.resolve = function(value) {
    // It seems A+ doesn't like the throw behavior
    // assertUnresolved();
    if (isResolved) return;
    if (isThenable(value)) {
      // FIXME(slightlyoff): use .then() for compat?
      if (typeof value.done == "function") {
        value.done(resolver.resolve, resolver.reject);
      } else {
        value.then(resolver.resolve, resolver.reject);
      }
      return;
    }
    resolver.accept(value);
    // Set isResolved last to ensure that accept() doesn't throw
    isResolved = true;
  };

  // Directly accepts the future, no matter what value's type is
  this.accept = function(value) {
    // assertUnresolved();
    if (isResolved) return;
    isResolved = true;
    async(function() {
      setState("accepted");
      setValue(value);
      acceptCallbacks.pump(value);
    });
  };

  // Rejects the future
  this.reject = function(error) {
    // assertUnresolved();
    if (isResolved) return;
    isResolved = true;
    async(function() {
      setState("rejected");
      setError(error);
      rejectCallbacks.pump(error);
    });
  };

  this.cancel  = function() { resolver.reject(new Error("Cancel")); };
  this.timeout = function() { resolver.reject(new Error("Timeout")); };

  Object.defineProperties(this, {
    isResolved: _readOnlyProperty(function() { return isResolved; })
  });

  setState("pending");
};

var Future = function(init) {
  var acceptCallbacks = new Backlog();
  var rejectCallbacks = new Backlog();
  var value;
  var error;
  var state = "pending";

  Object.defineProperties(this, {
    value: _readOnlyProperty(function() { return value; }),
    error: _readOnlyProperty(function() { return error; }),
    state: _readOnlyProperty(function() { return state; }),
    _addAcceptCallback: _pseudoPrivate(
      function(cb) {
        acceptCallbacks.push(cb);
        if (state == "accepted") {
          acceptCallbacks.pump(value);
        }
      }
    ),
    _addRejectCallback: _pseudoPrivate(
      function(cb) {
        rejectCallbacks.push(cb);
        if (state == "rejected") {
          rejectCallbacks.pump(error);
        }
      }
    ),
  });
  if (init) {
    init(new Resolver(this,
                      acceptCallbacks, rejectCallbacks,
                      function(v) { value = v; },
                      function(e) { error = e; },
                      function(s) { state = s; }));
  }
};

var isCallback = function(any) {
  return (typeof any == "function");
};

// Used in .then()
var wrap = function(callback, resolver, disposition) {
  if (!isCallback(callback)) {
    // If we don't get a callback, we want to forward whatever resolution we get
    return resolver[disposition].bind(resolver);
  }

  return function() {
    try {
      var r = callback.apply(null, arguments);
      resolver.resolve(r);
    } catch(e) {
      // Exceptions reject the resolver
      resolver.reject(e);
    }
  };
};

var addCallbacks = function(onaccept, onreject, scope) {
  if (isCallback(onaccept)) {
    scope._addAcceptCallback(onaccept);
  }
  if (isCallback(onreject)) {
    scope._addRejectCallback(onreject);
  }
  return scope;
};

Future.prototype = Object.create(null, {
  "then": _public(function(onaccept, onreject) {
    // The logic here is:
    //    We return a new Future whose resolution merges with the return from
    //    onaccept() or onerror(). If onaccept() returns a Future, we forward
    //    the resolution of that future to the resolution of the returned
    //    Future.
    var f = this;
    return new Future(function(r) {
      addCallbacks(wrap(onaccept, r, "resolve"),
                   wrap(onreject, r, "reject"), f);
    });
  }),
  "done": _public(function(onaccept, onreject) {
    return addCallbacks(onaccept, onreject, this);
  }),
  "catch": _public(function(onreject) {
    return addCallbacks(null, onreject, this);
  }),
});

// Statics

global.Future = Future;

})(this, (typeof window !== 'undefined') ? window : {});
