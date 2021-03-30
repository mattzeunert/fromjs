import * as OperationTypes from "./OperationTypes";
import { instrumentAndRun, server } from "./testHelpers";
import { compileSync } from "./compile";

test("adds 1 + 2 to equal 3", done => {
  instrumentAndRun("return 1 + 2").then(({ normal, tracking }) => {
    expect(normal).toBe(3);
    expect(tracking.operation).toBe(OperationTypes.binaryExpression);
    expect(tracking.args.left.operation).toBe(OperationTypes.numericLiteral);

    done();
  });
});

test("Can handle variable declarations with init value", done => {
  instrumentAndRun(`
    var a = "Hello", b = 2
    return b
  `).then(({ normal, tracking }) => {
    expect(normal).toBe(2);
    expect(tracking.args.value.operation).toBe("numericLiteral");

    done();
  });
});

describe("try catch", () => {
  test("Can handle try catch statements", done => {
    instrumentAndRun(`
      try {
        throw Error("e")
      } catch (err) {
        var a = err
      }
      return null
    `).then(({ normal, tracking, code }) => {
      done();
    });
  });
});

test("Does not break obj.val -=", async () => {
  const { normal, tracking, code } = await instrumentAndRun(`
    var obj = {val: 5}
    obj.val -= 2
    return obj.val
  `);

  expect(normal).toBe(3);
});

describe("delete expression", () => {
  test("Does not break delete expression", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
      var obj = {val: 5}
      delete obj.val
      return obj.val
    `);

    expect(normal).toBe(undefined);
  });
  test("Does not break delete expression with computed property name", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
      var obj = {val: 5}
      delete obj["val"]
      return obj.val
    `);

    expect(normal).toBe(undefined);
  });
  test("delete operation returns true if property can be deleted", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
      var obj = {val: 5}
      return delete obj["val"]
    `);

    expect(normal).toBe(true);
  });
  test("delete operation returns false if property can't be deleted", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
      var obj = {val: 5}
      Object.freeze(obj)
      return delete obj["val"]
    `);

    expect(normal).toBe(false);
  });
  test("Doesn't break when deleting key from boolean", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
      return delete false["key"]
    `);

    expect(normal).toBe(true);
  });
  test("Doesn't break deleting from global scope", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
      abcd = "abcd";
      delete abcd;
      return global.abcd
    `);

    expect(normal).toBe(undefined);
  });
});

describe("UnaryExpression", () => {
  test("Can handle ++ unary expresion", done => {
    instrumentAndRun(`
      var a = 0
      a++
      return a
    `).then(({ normal, tracking }) => {
      expect(normal).toBe(1);
      done();
    });
  });

  test("Does not break negative numeric literals", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
        return -100
      `);

    expect(normal).toBe(-100);
    expect(tracking.result.primitive).toBe(-100);
  });

  test("Does not break minus sign before identifier", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
        const num = 100
        return -num
      `);

    expect(normal).toBe(-100);
    expect(tracking.result.primitive).toBe(-100);
  });
});

test("Can handle function expressions", done => {
  instrumentAndRun(`
    var fn = function sth(){}
    return null
  `).then(({ normal, tracking }) => {
    done();
  });
});

test("Can handle typeof on non existent variables", done => {
  instrumentAndRun(`
    return typeof a
  `).then(({ normal, tracking }) => {
    done();
  });
});

describe("Can handle variables that aren't declared explicitly", () => {
  test("global variables", done => {
    instrumentAndRun(`
      global.__abcdef = "a"
      __abcdef = "b"
      return 0
    `).then(({ normal, tracking }) => {
      done();
    });
  });
  test("global variables in function calls", done => {
    instrumentAndRun(`
      var fnGlobal = function(){}
      fnGlobal(global)
      return 0
    `).then(({ normal, tracking }) => {
      done();
    });
  });
  test("arguments object", done => {
    instrumentAndRun(`
      var fn = function(a){ return a * 2 }
      var fn2 = function() { return fn(arguments[0]) }
      return fn2(2)
    `).then(({ normal, tracking }) => {
      expect(normal).toBe(4);
      done();
    });
  });
});

describe("Can handle while loops correctly", () => {
  test("simple", done => {
    instrumentAndRun(`
      var list = [1]
      var item
      var counter =0
      while (item = list.pop()) {
        counter++
        if (counter > 1) {
          throw Error("counter value too high")
        }
      }
      return counter
    `).then(({ normal, tracking, code }) => {
      expect(normal).toBe(1);
      done();
    });
  });
  test("complex", done => {
    instrumentAndRun(`
      var list = [1, null]
      var item
      var counter = 0
      while ((item = list.shift()) !== null) {
        counter++
        if (counter > 1) {
          throw Error("counter value too high")
        }
      }

      return counter
    `).then(({ normal, tracking, code }) => {
      expect(normal).toBe(1);
      done();
    });
  });
});

test("Can handle assignments in if statements", done => {
  instrumentAndRun(`
    var a
    if (a=0) {
      return "not ok"
    }
    return "ok"
  `).then(({ normal, tracking }) => {
    expect(normal).toBe("ok");
    done();
  });
});

test("Can handle for loops that contain assignments in the condition", done => {
  instrumentAndRun(`
    var elems = [{n: 1}, {n: 2}]
    var elem
    var i = 0
    for ( ; (elem = elems[ i ]) !== undefined; i++ ) {
      if (!elem || typeof elem.n !== "number") {
        throw Error("fail")
      }
    }
    return 0
  `).then(({ normal, tracking }) => {
    done();
  });
});

test("Does not call getters twice when making calls", done => {
  instrumentAndRun(`
    var obj = {}
    var getterInvocationCount = 0
    Object.defineProperty(obj, "sth", {
      get: function(){
        getterInvocationCount++
        return {
          fn: function(){
            return 99
          }
        }
      }
    })

    var val = obj.sth.fn()
    if (getterInvocationCount > 1) {
      throw Error("getter called too often")
    }
    return 0
  `).then(({ normal, tracking }) => {
    done();
  });
});

test("Returns the assigned value from assignments", done => {
  instrumentAndRun(`
    var b
    var a = (b = 5)
    return a
  `).then(({ normal, tracking }) => {
    expect(normal).toBe(5);
    done();
  });
});

describe("Object literals", () => {
  test("Can handle object literals", done => {
    instrumentAndRun(`
      var stringKey = {"a": "a"}
      var numberKey = {1: "a"}
      return {a: "a"}
    `).then(({ normal, tracking, code }) => {
      expect(normal.a).toBe("a");
      done();
    });
  });

  test("Tracks object literal values", done => {
    instrumentAndRun(`
      var obj = {
        a: 5,
        b: 6
      }
      return obj.a
    `).then(({ normal, tracking }) => {
      expect(normal).toBe(5);

      done();
    });
  });

  test("Doesn't break object literals with object methods", done => {
    instrumentAndRun(`
      var obj = {
        fn() { return 3}
      }
      return obj.fn()
    `).then(({ normal, tracking }) => {
      expect(normal).toBe(3);

      done();
    });
  });

  test("Doesn't break object literals with object methods", done => {
    instrumentAndRun(`
      var obj = {
        get sth() { return 4}
      }
      return obj.sth
    `).then(({ normal, tracking }) => {
      expect(normal).toBe(4);

      done();
    });
  });
});

test("Tracks object property assignments", done => {
  instrumentAndRun(`
    var obj = {}
    obj.a = 5
    return obj.a
  `).then(({ normal, tracking }) => {
    expect(normal).toBe(5);
    done();
  });
});

test("Object property assignment supports all operators", async () => {
  const { normal, tracking, code } = await instrumentAndRun(`
    var obj = { val1: 10, val2: 10 }
    obj.val1 += 1
    obj.val1 -= 1
    obj.val1 *= 5
    obj.val1 /= 5
    obj.val1 %= 4
    obj.val1 **= 2
    obj.val2 <<= 1
    obj.val2 >>= 1
    obj.val2 >>>= 1
    obj.val2 &= 0b11
    obj.val2 |= 0b111
    obj.val2 ^= 0b1111
    return obj.val1 + obj.val2	
  `);
  expect(normal).toBe(12);
});

test("Tracks object property assignments with computed properties", done => {
  instrumentAndRun(`
    var obj = {}
    obj["a"] = 5
    return obj.a
  `).then(({ normal, tracking }) => {
    expect(normal).toBe(5);

    done();
  });
});

test("Tracks where a function's context came from", done => {
  instrumentAndRun(`
    var a = "a"
    return a.slice(0)
  `).then(({ normal, tracking, code }) => {
    // function context is string "a"
    var identifier = tracking.args.context;
    expect(identifier.args.value.operation).toBe("stringLiteral");

    done();
  });
});

describe("Tracks values across assignments", () => {
  it("Works when assigning a new value", done => {
    instrumentAndRun(`
    var a = "a"
    a = "b"
    return a
  `).then(({ normal, tracking, code }) => {
      var strLit = tracking.args.value.args.argument;
      expect(strLit.operation).toBe("stringLiteral");
      expect(strLit.result.primitive).toBe("b");

      done();
    });
  });
  it("Works when assigning a variable value", done => {
    instrumentAndRun(`
    var a = "a"
    var b = "b"
    a = b
    return a
  `).then(({ normal, tracking, code }) => {
      expect(normal).toBe("b");
      expect(tracking.args.value.args.newValue.args.value.operation).toBe(
        "stringLiteral"
      );

      done();
    });
  });
});

it("Can track `-` binary expressions", done => {
  instrumentAndRun(`
    var a = 10 - 8
    return a
  `).then(({ normal, tracking, code }) => {
    expect(normal).toBe(2);
    expect(tracking.args.value.operation).toBe("binaryExpression");

    done();
  });
});

it("Can track `/=` binary expressions", done => {
  instrumentAndRun(`
    var a = 10
    a /= 2
    return a
  `).then(({ normal, tracking, code }) => {
    expect(normal).toBe(5);

    var assignmentExpression = tracking.args.value;
    expect(assignmentExpression.operation).toBe(
      OperationTypes.assignmentExpression
    );

    expect(assignmentExpression.astArgs.operator).toBe("/=");
    expect(assignmentExpression.args.currentValue.result.primitive).toBe(10);
    expect(assignmentExpression.args.argument.result.primitive).toBe(2);

    done();
  });
});

describe("AssignmentExpression", () => {
  it("Does not invoke memberExpression objects more than once", done => {
    instrumentAndRun(`
      var counter = 0
      var obj = {val:"a"}
      function a() {
        counter++;
        return obj
      }
      a().val += "b"
      return [counter, obj.val]    
    `).then(({ normal, tracking, code }) => {
      expect(normal[0]).toBe(1);
      expect(normal[1]).toBe("ab");

      done();
    });
  });
});

it("Tracks array expressions", done => {
  instrumentAndRun(`
    var a = [1,2,3]
    return a
  `).then(({ normal, tracking, code }) => {
    expect(normal).toEqual([1, 2, 3]);
    expect(tracking.args.value.args.element0.operation).toBe("numericLiteral");

    done();
  });
});

describe("Supports ++ and -- operators", () => {
  it("Doesn't break the ++ operator when used on an identifier", done => {
    instrumentAndRun(`
    var a = 5
    a++
    return a
  `).then(({ normal, tracking, code }) => {
      expect(normal).toBe(6);
      done();
    });
  });
  it("Doesn't break the -- operator when used on an identifier", done => {
    instrumentAndRun(`
    var a = 5
    a--
    return a
  `).then(({ normal, tracking, code }) => {
      expect(normal).toBe(4);
      done();
    });
  });
  it("Doesn't break the ++ operator when used on a member expression", done => {
    instrumentAndRun(`
    var obj = {a: 5}
    obj.a++
    var x= obj.a
    return x
  `).then(({ normal, tracking, code }) => {
      expect(normal).toBe(6);
      done();
    });
  });
});

describe("String replace", () => {
  it("Collects extra data on replace calls", done => {
    instrumentAndRun(`
      var a = "ab".replace("b", "c")
      return a
    `).then(({ normal, tracking, code }) => {
      expect(normal).toBe("ac");
      const replacement = tracking.args.value.extraArgs.replacement0;
      const replacementValue = replacement.args.value;
      expect(replacementValue.operation).toBe("stringLiteral");
      expect(replacementValue.result.primitive).toBe("c");
      expect(replacement.runtimeArgs.start).toBe(1);
      expect(replacement.runtimeArgs.end).toBe(2);

      done();
    });
  });

  it("Doesn't break $n replacements", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
      var str = "abcad".replace(/(a)/g, "$1$1")
      return str
    `);
    expect(normal).toBe("aabcaad");
  });

  it("Doesn't break $& replacements", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
      var str = "abcad".replace(/(a)(b)/g, "-$&-$2#")
      return str
    `);
    expect(normal).toBe("-ab-b#cad");
  });

  it("Doesn't break function replacements", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
      var str = "ab".replace(/(a)/g, function(match){return match + "x"})
      return str
    `);
    expect(normal).toBe("axb");
  });
});

describe("JSON.parse", () => {
  it("Collects extra data on JSON.parse calls", done => {
    instrumentAndRun(`
    var obj = JSON.parse('{"a": {"b": 5}}')
    return obj.a.b
  `).then(({ normal, tracking, code }) => {
      expect(normal).toBe(5);
      const memberExpression = tracking;
      const propertyValue = tracking.extraArgs.propertyValue;
      const json = propertyValue.args.json;
      const keyPath = propertyValue.runtimeArgs.keyPath;
      expect(json.result.primitive).toBe('{"a": {"b": 5}}');
      expect(keyPath).toEqual(["a", "b"]);

      done();
    });
  });
  it("Doesn't break on null values", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
      return JSON.parse('{"a": null}')
    `);
  });
});

it("Tracks arguments to NewExpressions", async () => {
  const { normal, tracking, code } = await instrumentAndRun(`
  function Obj(num) {
    this.num = num
  }
  var obj = new Obj(2)
  return obj.num
`);
  expect(normal).toBe(2);
  const memberExpression = tracking;
  const assignedValue = memberExpression.extraArgs.propertyValue.args.argument;
  expect(assignedValue.args.value.operation).toBe("numericLiteral");
});

it("Doesn't break when encountering a labeled statement", async () => {
  const { normal, tracking, code } = await instrumentAndRun(`
  // taken from mdn
  var str = "";

  block: {
    loop1:
    for (var i = 0; i < 5; i++) {
      if (i === 1) {
        continue loop1;
      }
      str = str + i;
      if (i > 3) {
        break block
      }
    }
    str += "x"
  }

  done:

  return str
`);
  expect(normal).toBe("0234");
});

// Ideally we should detect if the uninstrumented code had "use strict"
// and only add "use strict" if it was there before
it("Doesn't break on assignment to undeclared global variables", async () => {
  const { normal, tracking, code } = await instrumentAndRun(`
    a = 10
    return a
  `);
  expect(normal).toBe(10);
});

it("Doesn't break when using non-strict mode features like with", async () => {
  const { normal, tracking, code } = await instrumentAndRun(`
    const obj = {a:1}
    let num
    with (obj) {
      num = a
    }
    return num
  `);
  expect(normal).toBe(1);
});

describe("eval/new Function", () => {
  function __fromJSEval(code) {
    const compilationResult = compileSync(code);
    let compiledCode = compilationResult.code;
    server._locStore.write(compilationResult.locs, function() {});
    return {
      returnValue: getEvalFn().call(this, compiledCode),
      evalScript: []
    };
  }
  let evalFn;
  function setEvalFn(fn) {
    evalFn = fn;
  }
  function getEvalFn() {
    let ret;
    if (evalFn) {
      ret = evalFn;
      evalFn = null;
    } else {
      ret = eval;
    }
    return ret;
  }
  beforeEach(() => {
    global["__fromJSEvalSetEvalFn"] = setEvalFn;
  });
  afterEach(() => {
    delete global["__fromJSEval"];
    delete global["__fromJSEvalSetEvalFn"];
  });
  it("Doesn't break when no compilation function __fromJSEval is available", async () => {
    global["__forTestsDontShowCantEvalLog"] = true;
    const { normal, tracking, code } = await instrumentAndRun(`
      return eval("5")
    `);
    delete global["__forTestsDontShowCantEvalLog"];
    expect(normal).toBe(5);
  });
  it("Compiles eval'd code if __fromJSEval is available", async () => {
    global["__fromJSEval"] = __fromJSEval;
    const { normal, tracking, code } = await instrumentAndRun(`
      return eval("5")
    `);
    expect(normal).toBe(5);
    const callExpression = tracking;
    expect(callExpression.extraArgs.returnValue.operation).toBe(
      "numericLiteral"
    );
  });
  it("Compiles new Function() code if __fromJSEval is available", async () => {
    global["__fromJSEval"] = __fromJSEval;
    const { normal, tracking, code } = await instrumentAndRun(`
      const sum = new Function("a", "b", "return a + b");
      return sum(1,2)
    `);
    expect(normal).toBe(3);
    const callExpression = tracking;
    const returnValue = callExpression.extraArgs.returnValue;
    expect(returnValue.args.returnValue.operation).toBe("binaryExpression");
  });
  it("Allows access to local scope variables when calling a function called `eval`", async () => {
    global["__fromJSEval"] = __fromJSEval;

    const { normal, tracking, code } = await instrumentAndRun(`
      const localValue = 99
      const ret = eval("localValue")
      return ret
    `);
    expect(normal).toBe(99);
  });
  // Don't support apply/call right now...
  // Ideally they (and also eval if it has another name) should be supported, but it's
  // harder to predict at compile time, and we don't want to create the eval function for every single
  // function call
  // it("Allows access to local scope variables when calling a function called `eval` with call", async () => {
  //   global["__fromJSEval"] = __fromJSEval;

  //   const { normal, tracking, code } = await instrumentAndRun(`
  //     const localValue = 99
  //     const ret = eval.call(null, "localValue")
  //     return ret
  //   `);
  //   expect(normal).toBe(99);
  // });
  // it("Allows access to local scope variables when calling a function called `eval` with apply", async () => {
  //   global["__fromJSEval"] = __fromJSEval;

  //   const { normal, tracking, code } = await instrumentAndRun(`
  //     const localValue = 99
  //     const ret = eval.apply(null, ["localValue"])
  //     return ret
  //   `);
  //   expect(normal).toBe(99);
  // });
  it("Does not break local function called `eval`", async () => {
    global["__fromJSEval"] = __fromJSEval;
    const { normal, tracking, code } = await instrumentAndRun(`
      function eval() {
        return 11
      }
      return eval()
    `);
    expect(normal).toBe(11);
  });
});

describe("with statement", () => {
  it("Keeps tracking data through with statements", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
        const obj = { a : 5}
        let ret
        with (obj) {
          ret = a
        }
        return ret
      `);

    expect(normal).toBe(5);
    const assignmentExpression = tracking.args.value;
    const objectProperty =
      assignmentExpression.args.argument.extraArgs.propertyValue;
    expect(objectProperty.args.propertyValue.operation).toBe("numericLiteral");
  });
  it("Doesn't break identifiers in memberexpressions", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
        const obj = { arr: [1,2] }
        let ret = ""
        with (obj) {
          arr.forEach(function (num){
            ret += num
          })
        }
        return ret
      `);
    expect(normal).toBe("12");
  });
  it("Doesn't break expressions as with object argument", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
        const obj = { arr: [1,2] }
        let ret = ""
        with (null || obj) {
          arr.forEach(function (num){
            ret += num
          })
        }
        return ret
      `);
    expect(normal).toBe("12");
  });
});

describe("localStorage", () => {
  it("Tracks a localStorage value accessed using localStorage.prop", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
        localStorage.setItem("prop", "hi")
        return localStorage.prop
      `);
    expect(normal).toBe("hi");
    expect(tracking.args.object.result.knownValue).toBe("localStorage");
  });
  it("Tracks a localStorage value accessed using localStorage.getItem('prop')", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
        localStorage.setItem("prop", "hi")
        return localStorage.getItem("prop")
      `);
    expect(normal).toBe("hi");
    expect(tracking.args.function.result.knownValue).toBe(
      "localStorage.getItem"
    );
  });
});

describe("call/apply/bind", () => {
  it("Doesn't break call", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
        function fn(b) {
          return this + b
        }
        return fn.call("a", "b")
      `);

    expect(normal).toBe("ab");

    const callExpression = tracking;
    const returnStatement = callExpression.extraArgs.returnValue;
    const binaryExpression = returnStatement.args.returnValue;
    const { left, right } = binaryExpression.args;

    expect(right.args.value.result.primitive).toBe("b");
  });

  it("Doesn't break apply", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
    function fn(b) {
      return this + b
  }
    return fn.apply("a", ["b"])
  `);

    expect(normal).toBe("ab");

    const binaryExpression = tracking.extraArgs.returnValue.args.returnValue;

    const bArg = binaryExpression.args.right.args.value;
    expect(bArg.operation).not.toBe("arrayExpression"); // apply passes in array but it's not an argument
    expect(bArg.operation).toBe("stringLiteral");
  });

  it("Doesn't break apply", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
    function fn(b) {
      return this + b
    }
    fn = fn.bind("a")
    return fn("b")
  `);

    expect(normal).toBe("ab");
  });
  it("Doesn't break when calling apply without arguments", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
    function fn() {
      return 5
    }
    return fn.apply()
  `);

    expect(normal).toBe(5);
  });
});

describe("for ... in", () => {
  test("Can handle multiple complex nested for in statements", done => {
    // based on some Trello source code that caused problems
    instrumentAndRun(`
      var obj = {
        obj2: {a: 5}
      }
      var key1, key2
      var vOuter, vInner,x
      function getValue(obj, key) {
        return obj[key]
      }
      for (key in obj)
        for (key2 in ((x = 12), (vOuter = getValue(obj, key))))
          (vInner = vOuter[key2]), (vInner += 2);

      return vInner /* 7 */ + x /* 12 */

    `).then(({ normal, tracking }) => {
      expect(normal).toBe(19);
      done();
    });
  });

  it("Tracks for in key variables", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
    const obj = {a: "b"}
    let ret
    for (var name in obj) {
      ret = name
    }
    return ret
  `);
    expect(normal).toBe("a");
    const assignedValue = tracking.args.value.args.argument;
    expect(assignedValue.args.value.operation).toBe("stringLiteral");
  });

  it("Doesn't break if the body doesn't have a block statement, i.e. {}", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
    const obj = {a: "b"}
    let ret
    for (var name in obj) ret = name
    return ret
  `);

    expect(normal).toBe("a");
    const assignedValue = tracking.args.value.args.argument;
    expect(assignedValue.args.value.operation).toBe("stringLiteral");
  });

  it("Supports the variable being declared outside the for in loop", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
    const obj = {a: "b"}
    let ret
    let name
    for (name in obj) ret = name
    return ret
  `);

    expect(normal).toBe("a");
    const assignedValue = tracking.args.value.args.argument;
    expect(assignedValue.args.value.operation).toBe("stringLiteral");
  });

  it("Doesn't evaluate for in statement right value more than once", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
    let counter = 0
    function getObj() {
      counter++
      return {a: 1, b: 2, c: 3}
    }
    for (var key in getObj()) {

    }
    return counter
  `);

    expect(normal).toBe(1);
  });

  it("Doesn't break if the for in statement contains a for loop", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
    var obj = {a: [1,2,3]}
      var arr = []
      for (var key in obj) 
        for (var i=0; i< obj[key].length; i++)
          arr.push(obj[key][i])
    return arr
  `);

    expect(normal).toEqual([1, 2, 3]);
  });

  it("Doesn't break when for in loop is in an if statement without a block expression", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
      if (true)
        for (b in {a: 2})
          return b
    `);

    expect(normal).toEqual("a");
  });
});

describe("Doesn't break classes", () => {
  it("Doesn't break class methods", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
      const C = class {
        getA() {
          return "a";
        }
      };
      return new C().getA();
    `);

    expect(normal).toBe("a");
  });
});

describe("Doesn't break bitwise operators", () => {
  it("Doesn't break | and & for variables", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
      const FLAG1 = 0b100
      const FLAG2 = 0b010
      let value = 0
      value |= FLAG1
      value = value | FLAG2
      return value & FLAG1
    `);
    expect(normal).toBe(0b100);
  });
  it("Doesn't break | and & for object properties", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
      const FLAG1 = 0b100
      const FLAG2 = 0b010
      let obj = {value: 0}
      obj.value |= FLAG1
      obj.value = obj.value | FLAG2
      const ret = {value: obj.value}
      ret.value &= FLAG1
      return ret.value
    `);
    expect(normal).toBe(0b100);
  });
});

it("Doesn't break for loop with empty string as condition", async () => {
  const { normal, tracking, code } = await instrumentAndRun(`
      var wasInBody = false;
      for (var a=0; "";) {
          wasInBody = true;
          break;
      }
      return wasInBody;
    `);
  expect(normal).toBe(false);
});

describe("Logical Expressions", () => {
  it("Doesn't break nested AND/OR expressions", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
        return (1 && 2) || 3
      `);
    expect(normal).toBe(2);
  });
});

it("Can handle nested conditional operators", async () => {
  const { normal, tracking, code } = await instrumentAndRun(`
      var a = true ? ('' ? null : ({} ? 'yes' : null)) : null;
      return a
    `);
  expect(normal).toBe("yes");
});

it("Doesn't break when calling Object.assign with undefined/falsy values", async () => {
  const { normal, tracking, code } = await instrumentAndRun(`
      var obj = Object.assign({}, false, null, undefined, {a:"a"})
      return obj.a
    `);
  expect(normal).toBe("a");
});

it("Doesn't break when calling .apply with no args", async () => {
  const { normal, tracking, code } = await instrumentAndRun(`
    let fn = function() {return this.a};
    let ctx = {a: "a"}
    return fn.apply(ctx)
  `);
  expect(normal).toBe("a");
});

it("Does't break when encountering a for in statement", async () => {
  const { normal, tracking, code } = await instrumentAndRun(`
  
  const arr = [1,2,3]
  let res = ""
  for (const sth in arr) {
    res += sth
  }
  return res
  `);
  expect(normal).toBe("012");
});

it("Does't break array destructuring with fewer named arguments than the total", async () => {
  const { normal, tracking, code } = await instrumentAndRun(`
    const [one, two] = ["one"].splice(0, 2)
    return one + two
  `);
  expect(normal).toBe("oneundefined");
});

describe("Doesn't break when using ES6+ features", () => {
  it("Doesn't break with classes", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
      class A {
        fn() {
          return "sth"
        }
      }
      return new A().fn()
    `);
    expect(normal).toBe("sth");
  });
  it("Doesn't break when there are destructured variables", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
    function f({a:x,b:y}){return x+y}
    f({a:1,b:2});
    function f2({a,b}){return a+b}
    f2({a:1,b:2});
    let {a:aaa} = {a:4}
    aaa+=1;
    let [c, d=5] = [1]
    c= c-1
    d = d-1
    function f3([a,b]) {
      return a + b
    }
    f3([4,5])
    let m,n;
    ({m,n=3} = {});
    m += n;

    
    let [x = true, y] = []
    x = x && y
    return 5
    `);
    expect(normal).toBe(5);
  });

  it("Does't break when encountering a for of statement", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
    const arr = [4]
    for (const elem of arr) {
      return elem
    }
    `);
    expect(normal).toBe(4);
  });

  it("Does't break when encountering an arrow function", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
    const square = a => a * a;
    const add = (a,b) => {return a + b};
    return add(square(2), 1);
    `);
    expect(normal).toBe(5);
  });

  describe("Does't break when calling a function on super", () => {
    it("Call method on super", async () => {
      const { normal, tracking, code } = await instrumentAndRun(`
      class Parent {
        square(x) { return x * x}
      }
      class Child extends Parent {
        getSquare(n) {
          return super.square(n)
        }   
      }
      return new Child().getSquare(3)
    `);
      expect(normal).toBe(9);
    });

    it("Call super constructor", async () => {
      const { normal, tracking, code } = await instrumentAndRun(
        `
      class Parent {
        constructor(num) {
          this.num = num
        }

        getNum() {
          return this.num
        }
      }
      class Child extends Parent {
        constructor(num) {
          super(num);
        }
      }

      return new Child(4).getNum()
    `,
        {},
        { logCode: false }
      );

      expect(normal).toBe(4);
    });

    it("Can still access bound context when call to super method is made", async () => {
      const { normal, tracking, code } = await instrumentAndRun(
        `
        class K {
          constructor() {
            this.sth = "abc"
          }
          getValue() {
            return this.sth
          }
        }
        class C extends K {
          getV() {
            const obj = {sth: "xyz"}
            obj.yyy
            return super.getValue()
          }
        }
        const k = new C()
        return k.getV()
      `
      );
      expect(normal).toBe("abc");
    });
  });

  it("Doesn't break when using array destructuring in a for of statement", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
      let sum =0
      for (const [key, value] of Object.entries({a: 1, b: 2})) {
        sum += value + key.length
      }
      return sum
    `);
    expect(normal).toBe(5);
  });

  it("Doesn't break when using array destructuring in a for of statement with variables pre-defined", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
      let sum =0
      let key, value
      for ([key, value] of Object.entries({a: 1, b: 2})) {
        sum += value + key.length
      }
      return sum
    `);
    expect(normal).toBe(5);
  });

  it("Doesn't break code that destructures arrays", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
      function getFirst([v]) {
        return v
      }

      const [v1, v2] = [1,2]
      let v3, v4;
      ([v3, v4] = [1,2]);
      let v5 = getFirst([1])
      return v1 + v2 + v3 + v4 + v5
    `);
    expect(normal).toBe(7);
  });

  it("Doesn't break rest parameter code for array or object pattern", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
      const [a, ...b] = [1,2,3,4,5]
      const {c, ...d} = {x: 6}

      return b.length  + d.x
    `);

    expect(normal).toBe(10);
  });

  it("Doesn't break for of loops destructuring a map", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
      let m = new Map();
      m.set("a", "b")
      m.set("x", "y")
      let res = ""
      for (const [key, value] of m) {
        res += key + value
      }
      return res   
  `);

    expect(normal).toBe("abxy");
  });

  it("Doesn't break spread parameter arguments", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
      function add(a, b, c, d) {
        return a + b + c + d
      }
      const nums1 = [1,2]
      const nums2 = [3,4]
      return add(...nums1, ...nums2)
    `);

    expect(normal).toBe(10);
  });

  it("It doesn't break spread parameter arguments that are arguments objects", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
      function add(a, b, c, d) {
        return a + b + c + d
      }
      function fn() {
        return add(...arguments)
      }
      return fn(1, 2, 3, 4)
    `);

    expect(normal).toBe(10);
  });

  describe("Doesn't break when using default parameter values", () => {
    it("Function declaration", async () => {
      const { normal, tracking, code } = await instrumentAndRun(`
      function add(a, b=1) {
        return a+b
      }
  
      return add(4)
    `);

      expect(normal).toBe(5);
    });

    it("class method", async () => {
      const { normal, tracking, code } = await instrumentAndRun(`
      class Adder {
        add(a, b=1) {
          return a+b
        }
      }
  
      return new Adder().add(4)
    `);

      expect(normal).toBe(5);
    });
  });

  it("Doesn't break function that have rest parameters", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
      function add(...args) {
        return args[1]
      }

      return add(1,2,3)
    `);

    expect(normal).toBe(2);
  });

  it("Doesn't break for of loops without a body block", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
      let ret
      const list = ["a", "b"]
      for (const item of list) ret = item
      return ret
    `);

    expect(normal).toBe("b");
  });

  it("Doesn't break class expressions", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
      const C = class CC {
        getA() {
          return "a"
        }
      }
      return new C().getA();
    `);

    expect(normal).toBe("a");
  });

  it("Doesn't break object patterns inside array patterns", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
      const concat = ([{a,b}]) => a + b
      return concat([{a: "x",b:"y"}])
    `);

    expect(normal).toBe("xy");
  });

  it("Doesn't break tagged template literals", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
      function t(strings, ...values) { 
        let str = '';
        strings.forEach((string, i) => {
           str += string + (values[i] || "").toUpperCase();
        });
        return str + "!";
      }
      return t${'`Hello ${"World"}`'}
    `);

    expect(normal).toBe("Hello WORLD!");
  });
});

it("Doesn't break if a for in loop creates a variable with the same name as one in the parent scope", async () => {
  const { normal, tracking, code } = await instrumentAndRun(
    `
    const a = 123;
    for (const a in ["a", "b", "c"]) {
      return a
    }
  `,
    {},
    { logCode: false }
  );

  expect(normal).toBe("0");
});

it("Doesn't break accessing a variable outside a for in loop if it creates a variable with var", async () => {
  const { normal, tracking, code } = await instrumentAndRun(
    `
    for (var a in ["a", "b", "c"]) {}
    return a
  `,
    {},
    { logCode: false }
  );

  expect(normal).toBe("2");
});

it("Doesn't break accessing a variable outside a for of loop if it creates a variable with var", async () => {
  const { normal, tracking, code } = await instrumentAndRun(
    `
    for (var a of ["a", "b", "c"]) {}
    return a
  `,
    {},
    { logCode: false }
  );

  expect(normal).toBe("c");
});

it("Doesn't break if a for of loop creates a variable with the same name as one in the parent scope", async () => {
  const { normal, tracking, code } = await instrumentAndRun(
    `
    const a = 123;
    for (const a of ["a", "b", "c"]) {
      return a
    }
  `,
    {},
    { logCode: false }
  );

  expect(normal).toBe("a");
});

it("Doesn't break catch clause if a variable has the same name as one in the parent scope", async () => {
  const { normal, tracking, code } = await instrumentAndRun(
    `
    const err = 123;
    try {
      throw Error("msg")
    } catch (err) {
      return err.message
    }
  `,
    {},
    { logCode: false }
  );

  expect(normal).toBe("msg");
});

it("Doesn't break for of loop variables when inside bodyless if", async () => {
  const { normal, tracking, code } = await instrumentAndRun(
    `
    const o= 1;
    const a = ["_"]
    if (true)
      for(const o in a) {
        return o
      }
  `,
    {},
    { logCode: false }
  );

  expect(normal).toBe("0");
});

it("Doesn't break if array element are empty", async () => {
  const { normal, tracking, code } = await instrumentAndRun(
    `
    const arr = [,1]
    return arr[1]
  `,
    {},
    { logCode: false }
  );

  expect(normal).toBe(1);
});

it("Doesn't break array spread elements that consume a Map", async () => {
  const { normal, tracking, code } = await instrumentAndRun(
    `
    const arr = [...new Map([["a", 1], ["b", 2]])]
    return arr[1][1]
  `,
    {},
    { logCode: false }
  );

  expect(normal).toBe(2);
});

it("Knows all properties of common objects as known values", async () => {
  const examples = [
    {
      code: "Math.min",
      knownValue: "Math.min"
    },
    {
      code: "''.endsWith",
      knownValue: "String.prototype.endsWith"
    },
    {
      code: "(5).toLocaleString",
      knownValue: "Number.prototype.toLocaleString"
    },
    {
      code: "({}).propertyIsEnumerable",
      knownValue: "Object.prototype.propertyIsEnumerable"
    }
  ];
  for (const example of examples) {
    const { normal, tracking, code } = await instrumentAndRun(
      `
      return ${example.code}
    `,
      {},
      { logCode: false }
    );

    expect(tracking.result.knownValue).toBe(example.knownValue);
  }
});

it("Object.assign stores information about the source object", async () => {
  const { normal, tracking, code } = await instrumentAndRun(`
      var obj = Object.assign({}, {source: 1})
      return obj.source
    `);
  expect(normal).toBe(1);
  const objectAssignResult = tracking.extraArgs.propertyValue;
  expect(objectAssignResult.args.sourceObject.result.keys).toEqual(["source"]);
});

describe("Doesn't break .bind", () => {
  it("Can still access bound context when making a plain function call", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
      function fn() {
        return this.toString()
      }
      fn = fn.bind("abc")
      return fn()
    `);
    expect(normal).toBe("abc");
  });
  it("Can still access bound context when calling a function with a member expression", async () => {
    const { normal, tracking, code } = await instrumentAndRun(`
      function fn() {
        return this.toString()
      }
      fn = fn.bind("abc")
      const obj = {fn}
      return obj.fn()
    `);
    expect(normal).toBe("abc");
  });
});

it("Should not break getter that assigns to itself", async () => {
  const { normal, tracking, code } = await instrumentAndRun(`
  const obj = {
    set sth(val) {
      this._sth = val
    },
    get sth() {
      // should not be infinite recursion
      this.sth = "abc"
      return "xyz"
    }
  }
  return obj.sth
`);
  expect(normal).toBe("xyz");
});

it("Doesn't break function argument array destructuring if some values aren't used", async () => {
  const { normal, tracking, code } = await instrumentAndRun(
    `
  function fn ([,b]) {
    return b
  }
  return fn(["a", "b"])
`,
    {},
    { logCode: false }
  );
  expect(normal).toBe("b");
});

it("Doesn't break nested for of statements without a body", async () => {
  const { normal, tracking, code } = await instrumentAndRun(
    `
    var i=["1"]
    var chars=["a"]
    let res = ""
    for (var x of i)
      for (var m of chars) 
        res += x + m
        
    return res
`,
    {},
    { logCode: false }
  );
  expect(normal).toBe("1a");
});

// it("Doesn't break if destructured variable is renamed", async () => {
//   const { normal, tracking, code } = await instrumentAndRun(
//     `
//     "use strict";
//     // as of April 2020 this is handled by compiling it in babel
//     const {a: {b:c}} = {a: {b: "c"}}
//   const a = "a"
//   return a + c
// `,
//     {},
//     { logCode: false }
//   );
//   expect(normal).toBe("ac");
// });
