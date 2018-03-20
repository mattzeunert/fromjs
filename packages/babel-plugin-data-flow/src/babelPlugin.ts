import * as FunctionNames from "./FunctionNames";
import * as babel from "@babel/core";
import * as OperationTypes from "./OperationTypes";
// import * as fs from "fs";
import * as babylon from "babylon";

import helperCodeLoaded from "./helperFunctions";
import helperFunctions from "./helperFunctions";
let helperCode = helperCodeLoaded.replace(
  "__FUNCTION_NAMES__",
  JSON.stringify(FunctionNames)
);
helperCode = helperCode.replace(
  "__OPERATION_TYPES__",
  JSON.stringify(OperationTypes)
);
helperCode += "/* HELPER_FUNCTIONS_END */ ";

// I got some babel-generator "cannot read property 'type' of undefined" errors
// when prepending the code itself, so just prepend a single eval call expression
helperCode = "eval(`" + helperCode + "`)";
// console.log(helperCode);

export default function plugin(babel) {
  const { types: t } = babel;

  var ignoredStringLiteral = function(str) {
    var l = t.stringLiteral(str);
    l.ignore = true;
    return l;
  };

  function ignoredIdentifier(name) {
    var id = t.identifier(name);
    id.ignore = true;
    return id;
  }

  function ignoredCallExpression(identifier, args) {
    var call = t.callExpression(ignoredIdentifier(identifier), args);
    call.ignore = true;
    return call;
  }

  function ignoredNumericLiteral(number) {
    var n = t.numericLiteral(number);
    n.ignore = true;
    return n;
  }

  function ignoredArrayExpression(items) {
    return ignoreNode(t.arrayExpression(items));
  }

  var getLastOperationTrackingResultCall = ignoredCallExpression(
    FunctionNames.getLastOperationTrackingResult,
    []
  );

  var getLastOpValue = ignoredCallExpression(
    FunctionNames.getLastOperationValueResult,
    []
  );

  function isInWhileStatement(path) {
    return isInNodeType("WhileStatement", path);
  }

  function isInIfStatement(path) {
    return isInNodeType("IfStatement", path);
  }

  function isInForStatement(path) {
    return isInNodeType("ForStatement", path);
  }

  function isInAssignmentExpression(path) {
    return isInNodeType("AssignmentExpression", path);
  }

  function isInLeftPartOfAssignmentExpression(path) {
    return isInNodeType("AssignmentExpression", path, function(path, prevPath) {
      return path.node.left === prevPath.node;
    });
  }

  function isInIdOfVariableDeclarator(path) {
    return isInNodeType("VariableDeclarator", path, function(path, prevPath) {
      return path.node.id === prevPath.node;
    });
  }

  function isInCallExpressionCallee(path) {
    return isInNodeType("CallExpression", path, function(path, prevPath) {
      return path.node.callee === prevPath.node;
    });
  }

  function isInNodeType(type, path, extraCondition = null, prevPath = null) {
    if (prevPath === null) {
      isInNodeType(type, path.parentPath, extraCondition, path);
    }
    if (path.node.type === "Program") {
      return false;
    }
    if (path.node.type === type) {
      if (!extraCondition || extraCondition(path, prevPath)) {
        return true;
      }
    }
    if (path.parentPath) {
      return isInNodeType(type, path.parentPath, extraCondition, path);
    }
  }

  function createOperation(opType, opArgs) {
    var call = babel.types.callExpression(
      ignoredIdentifier(FunctionNames.doOperation),
      [ignoredStringLiteral(opType), ...opArgs]
    );

    call.ignore = true;
    return call;
  }

  function ignoreNode(node) {
    node.ignore = true;
    return node;
  }

  function runIfIdentifierExists(identifierName, thenNode) {
    const iN = ignoreNode;
    return iN(
      t.logicalExpression(
        "&&",
        iN(
          t.binaryExpression(
            "!==",
            iN(t.UnaryExpression("typeof", ignoredIdentifier(identifierName))),
            ignoredStringLiteral("undefined")
          )
        ),
        thenNode
      )
    );
  }

  function trackingIdentifierIfExists(identifierName) {
    var trackingIdentifierName = identifierName + "_t";
    return runIfIdentifierExists(
      trackingIdentifierName,
      ignoredIdentifier(trackingIdentifierName)
    );
  }

  return {
    name: "babel-plugin-data-flow",
    visitor: {
      Program: {
        // Run on exit so injected code isn't processed by other babel plugins
        exit: function(path) {
          var initCodeAstNodes = babylon
            .parse(helperCode)
            .program.body.reverse();
          initCodeAstNodes.forEach(node => {
            path.node.body.unshift(node);
          });
        }
      },
      FunctionDeclaration(path) {
        path.node.params.forEach((param, i) => {
          var d = t.variableDeclaration("var", [
            t.variableDeclarator(
              ignoredIdentifier(param.name + "_t"),
              ignoredCallExpression(FunctionNames.getFunctionArgTrackingInfo, [
                ignoredNumericLiteral(i)
              ])
            )
          ]);
          d.ignore = true;
          path.node.body.body.unshift(d);
        });
      },
      StringLiteral(path) {
        if (path.parent.type === "ObjectProperty") {
          return;
        }
        if (path.node.ignore) {
          return;
        }
        path.node.ignore = true;
        const locId = t.stringLiteral(path.node.start + "-" + path.node.end);
        locId.ignore = true;
        var call = t.callExpression(
          ignoredIdentifier(FunctionNames.doOperation),
          [
            ignoredStringLiteral("stringLiteral"),
            ignoredArrayExpression([path.node, t.nullLiteral()])
          ]
        );
        call.ignore = true;
        path.replaceWith(call);
      },
      NumericLiteral(path) {
        if (path.parent.type === "ObjectProperty") {
          return;
        }
        if (path.node.ignore) {
          return;
        }
        path.node.ignore = true;

        var call = t.callExpression(
          ignoredIdentifier(FunctionNames.doOperation),
          [
            ignoredStringLiteral("numericLiteral"),
            ignoredArrayExpression([path.node, t.nullLiteral()])
          ]
        );
        call.ignore = true;
        path.replaceWith(call);
      },
      BinaryExpression(path) {
        if (["+", "-", "/", "*"].includes(path.node.operator)) {
          var call = t.callExpression(
            ignoredIdentifier(FunctionNames.doOperation),
            [
              ignoredStringLiteral(OperationTypes.binaryExpression),
              ignoredStringLiteral(path.node.operator),
              ignoredArrayExpression([
                path.node.left,
                getLastOperationTrackingResultCall
              ]),
              ignoredArrayExpression([
                path.node.right,
                getLastOperationTrackingResultCall
              ])
            ]
          );
          call.ignore = true;
          path.replaceWith(call);
        }
      },
      VariableDeclaration(path) {
        if (path.node.ignore) {
          return;
        }
        if (path.parent.type === "ForInStatement") {
          return;
        }
        var originalDeclarations = path.node.declarations;
        var newDeclarations = [];
        originalDeclarations.forEach(function(decl) {
          newDeclarations.push(decl);
          if (!decl.init) {
            decl.init = ignoredIdentifier("undefined");
          }

          newDeclarations.push(
            t.variableDeclarator(
              ignoredIdentifier(decl.id.name + "_t"),
              ignoredCallExpression(
                FunctionNames.getLastOperationTrackingResult,
                []
              )
            )
          );
        });
        path.node.declarations = newDeclarations;
      },
      AssignmentExpression(path) {
        if (path.node.ignore) {
          return;
        }
        path.node.ignore = true;

        if (
          path.node.operator === "=" &&
          path.node.left.type === "MemberExpression"
        ) {
          var property;
          if (path.node.left.computed === true) {
            property = path.node.left.property;
          } else {
            property = babel.types.stringLiteral(path.node.left.property.name);
            property.loc = path.node.left.property.loc;
          }
          let call = createOperation(OperationTypes.objectPropertyAssignment, [
            ignoredArrayExpression([path.node.left.object, t.nullLiteral()]),
            ignoredArrayExpression([property, t.nullLiteral()]),
            ignoredArrayExpression([
              path.node.right,
              getLastOperationTrackingResultCall
            ])
          ]);

          call.loc = path.node.loc;
          path.replaceWith(call);
          return;
        }

        if (!path.node.left.name) {
          return;
        }
        const trackingAssignment = runIfIdentifierExists(
          path.node.left.name + "_t",
          ignoreNode(
            t.assignmentExpression(
              "=",
              ignoredIdentifier(path.node.left.name + "_t"),
              getLastOperationTrackingResultCall
            )
          )
        );
        trackingAssignment.ignore = true;

        var call = t.callExpression(
          ignoredIdentifier(FunctionNames.doOperation),
          [
            ignoredStringLiteral(OperationTypes.assignmentExpression),
            ignoredArrayExpression([
              ignoredStringLiteral(path.node.operator),
              t.nullLiteral()
            ]),
            ignoredArrayExpression([
              path.node.left,
              getLastOperationTrackingResultCall
            ]),
            ignoredArrayExpression([
              path.node,
              getLastOperationTrackingResultCall
            ])
          ]
        );
        call.ignore = true;

        path.replaceWith(
          t.sequenceExpression([call, trackingAssignment, getLastOpValue])
        );
      },
      ObjectExpression(path) {
        path.node.properties.forEach(function(prop) {
          if (prop.key.type === "Identifier") {
            var keyLoc = prop.key.loc;
            prop.key = babel.types.stringLiteral(prop.key.name);
            prop.key.loc = keyLoc;
            // move start a bit to left to compensate for there not
            // being quotes in the original "string", since
            // it's just an identifier
            if (prop.key.loc.start.column > 0) {
              prop.key.loc.start.column--;
            }
          }
        });

        var call = createOperation(
          OperationTypes.objectExpression,
          path.node.properties.map(function(prop) {
            var type = t.stringLiteral(prop.type);
            type.ignore = true;
            if (prop.type === "ObjectMethod") {
              // getter/setter
              var kind = ignoredStringLiteral(prop.kind);
              kind.ignore = true;
              var propArray = ignoredArrayExpression([
                ignoredArrayExpression([type]),
                ignoredArrayExpression([prop.key]),
                ignoredArrayExpression(kind),
                ignoredArrayExpression([
                  babel.types.functionExpression(null, prop.params, prop.body)
                ])
              ]);
              return propArray;
            } else {
              var propArray = ignoredArrayExpression([
                ignoredArrayExpression([type]),
                ignoredArrayExpression([prop.key]),
                ignoredArrayExpression([
                  prop.value,
                  getLastOperationTrackingResultCall
                ])
              ]);
              return propArray;
            }
            // console.log("continue with type", prop.type);
          })
        );

        path.replaceWith(call);
      },
      MemberExpression(path) {
        if (isInLeftPartOfAssignmentExpression(path)) {
          return;
        }

        // todo: dedupe this code
        var property;
        if (path.node.computed === true) {
          property = path.node.property;
        } else {
          if (path.node.property.type === "Identifier") {
            property = babel.types.stringLiteral(path.node.property.name);
            property.loc = path.node.property.loc;
          }
        }
        path.replaceWith(
          createOperation(OperationTypes.memberExpression, [
            ignoredArrayExpression([
              path.node.object,
              getLastOperationTrackingResultCall
            ]),
            ignoredArrayExpression([
              property,
              getLastOperationTrackingResultCall
            ])
          ])
        );
      },
      ReturnStatement(path) {
        if (path.ignore) {
          return;
        }
        path.node.ignore = true;

        var opCall = ignoredCallExpression(FunctionNames.doOperation, [
          ignoredStringLiteral(OperationTypes.returnStatement),
          ignoredArrayExpression([
            path.node.argument,
            getLastOperationTrackingResultCall
          ])
        ]);

        path.node.argument = opCall;
      },
      Identifier(path) {
        if (path.node.ignore) {
          return;
        }
        if (
          path.parent.type === "FunctionDeclaration" ||
          path.parent.type === "CallExpression" ||
          path.parent.type === "MemberExpression" ||
          path.parent.type === "ObjectProperty" ||
          path.parent.type === "CatchClause" ||
          path.parent.type === "ForInStatement" ||
          path.parent.type === "IfStatement" ||
          path.parent.type === "ForStatement" ||
          path.parent.type === "FunctionExpression" ||
          path.parent.type === "UpdateExpression" ||
          (path.parent.type === "UnaryExpression" &&
            path.parent.operator === "typeof")
        ) {
          return;
        }
        if (
          isInLeftPartOfAssignmentExpression(path) ||
          isInIdOfVariableDeclarator(path)
        ) {
          return;
        }
        if (path.node.name === "globalFn") {
          return;
        }

        path.node.ignore = true;

        var call = ignoredCallExpression(FunctionNames.doOperation, [
          ignoredStringLiteral("identifier"),
          ignoredArrayExpression([
            path.node,
            trackingIdentifierIfExists(path.node.name)
          ])
        ]);

        try {
          path.replaceWith(call);
        } catch (err) {
          console.log(err);
          console.log(path.parent.type);
          throw Error("end");
        }
      },
      CallExpression(path) {
        if (path.node.ignore) {
          return;
        }

        const { callee } = path.node;

        var isMemberExpressionCall = callee.type === "MemberExpression";

        var args = [];
        path.node.arguments.forEach(arg => {
          args.push(
            ignoredArrayExpression([arg, getLastOperationTrackingResultCall])
          );
        });

        let executionContext;
        let executionContextTrackingValue;
        if (isMemberExpressionCall) {
          executionContext = ignoredCallExpression(
            "getLastMemberExpressionObjectValue",
            []
          );
          executionContextTrackingValue = ignoredCallExpression(
            "getLastMemberExpressionObjectTrackingValue",
            []
          );
        } else {
          executionContext = t.identifier("undefined");
          executionContextTrackingValue = t.nullLiteral();
        }

        var call = t.callExpression(ignoredIdentifier(FunctionNames.makeCall), [
          ignoredArrayExpression([
            ignoreNode(path.node.callee),
            isMemberExpressionCall
              ? getLastOperationTrackingResultCall
              : getLastOperationTrackingResultCall
          ]),
          ignoredArrayExpression([
            executionContext,
            executionContextTrackingValue
          ]),
          ignoredArrayExpression(args)
        ]);
        // call.loc = path.node.callee.loc;
        call.ignore = true;

        // todo: would it be better for perf if I just updated the existing call expression instead?
        path.replaceWith(call);
      }
    }
  };
}
