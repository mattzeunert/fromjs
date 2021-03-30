import * as FunctionNames from "./FunctionNames";
import * as babylon from "@babel/parser";
import operations, { shouldSkipIdentifier, initForBabel } from "./operations";
import {
  ignoreNode,
  ignoredArrayExpression,
  ignoredStringLiteral,
  ignoredIdentifier,
  ignoredCallExpression,
  ignoredNumericLiteral,
  createOperation,
  getLastOperationTrackingResultCall,
  runIfIdentifierExists,
  isInNodeType,
  isInIdOfVariableDeclarator,
  isInLeftPartOfAssignmentExpression,
  getTrackingVarName,
  addLoc,
  skipPath,
  getTrackingIdentifier,
  getLocObjectASTNode
} from "./babelPluginHelpers";

import helperCodeLoaded from "../helperFunctions";

import * as t from "@babel/types";
import { VERIFY } from "./config";
initForBabel(t, babylon);

var helperCode = `
  (function(){
    var global = Function("return this")();
    if (!global.__fromJSConfig) {
      global.__fromJSConfig = {
        VERIFY: ${VERIFY}
      }
    }
  })();
`;

helperCode += helperCodeLoaded.toString();

helperCode += "/* HELPER_FUNCTIONS_END */ ";

// I got some babel-generator "cannot read property 'type' of undefined" errors
// when prepending the code itself, so just prepend a single eval call expression
helperCode =
  `
  if (typeof __fromJSMaybeMapInitialPageHTML !== "undefined") {
    __fromJSMaybeMapInitialPageHTML()
  }
  var global = Function("return this")();
if (!global.__didInitializeDataFlowTracking) {` +
  "eval(`" +
  helperCode
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$") +
  "\n//# sourceURL=/helperFns.js`)" +
  "}";
helperCode += "// aaaaa"; // this seems to help with debugging/evaling the code... not sure why...just take it out if the tests dont break

// helperCode = ""

function plugin(babel) {
  const { types: t } = babel;

  function handleFunction(path) {
    const declarators: any[] = [];

    path.node.params.forEach((param, i) => {
      if (param.type === "ObjectPattern") {
        // do nothing for now, logic is in objectpattern visitor
        // for (var n = 0; n < param.properties.length; n++) {
        //   const prop = param.properties[n];
        //   declarators.push(
        //     t.variableDeclarator(
        //       addLoc(
        //         getTrackingIdentifier(
        //           prop.value ? prop.value.name : prop.key.name
        //         ),
        //         prop.loc
        //       ),
        //       t.nullLiteral()
        //     )
        //   );
        // }
      } else if (param.type === "ArrayPattern") {
        param.elements.forEach(elem => {
          let varName;
          if (!elem) {
            // e.g. [,,c]
          } else if (elem.type === "Identifier") {
            varName = elem.name;
          } else if (elem.type === "AssignmentPattern") {
            varName = elem.left.name;
          } else if (elem.type === "RestParameter") {
            varName = elem.argument.name;
          } else if (elem.type === "ObjectPattern") {
            // will be processed in ObjectPattern visitor
          } else {
            throw Error(
              "aaa unknown array pattern elem type " +
                elem.type +
                " " +
                JSON.stringify(path.node.loc)
            );
          }
          if (elem && varName) {
            declarators.push(
              t.variableDeclarator(
                addLoc(getTrackingIdentifier(varName), param.loc),
                ignoredCallExpression(FunctionNames.getEmptyTrackingInfo, [
                  ignoredStringLiteral("arrayPatternInFunction"),
                  getLocObjectASTNode(elem.loc),
                  ignoredIdentifier(varName)
                ])
              )
            );
          }
        });
      } else if (param.type === "AssignmentPattern") {
        let varName = param.left.name;
        declarators.push(
          t.variableDeclarator(
            addLoc(getTrackingIdentifier(varName), param.loc),
            ignoredCallExpression(FunctionNames.getEmptyTrackingInfo, [
              ignoredStringLiteral("assignmentPatternInFunction"),
              getLocObjectASTNode(param.loc),
              ignoredIdentifier(varName)
            ])
          )
        );
      } else if (param.type === "RestElement") {
        let varName = param.argument.name;
        declarators.push(
          t.variableDeclarator(
            addLoc(getTrackingIdentifier(varName), param.loc),
            ignoredCallExpression(FunctionNames.getEmptyTrackingInfo, [
              ignoredStringLiteral("restElement"),
              getLocObjectASTNode(param.loc)
            ])
          )
        );
      } else {
        declarators.push(
          t.variableDeclarator(
            addLoc(getTrackingIdentifier(param.name), param.loc),
            t.callExpression(
              t.identifier(FunctionNames.getFunctionArgTrackingInfo),
              [t.numericLiteral(i)]
            )
          )
        );
      }
    });

    // keep whole list in case the function uses `arguments` object
    // We can't just access the arg tracking values when `arguments` is used (instead of doing it
    // at the top of the function)
    // That's because when we return the argTrackingValues are not reset to the parent function's
    declarators.push(
      t.variableDeclarator(
        ignoredIdentifier("__allArgTV"),
        ignoredCallExpression(FunctionNames.getFunctionArgTrackingInfo, [])
      )
    );

    const d = t.variableDeclaration("var", declarators);
    skipPath(d);
    if (path.node.body.type !== "BlockStatement") {
      // arrow function
      path.node.body = ignoreNode(
        t.blockStatement([t.returnStatement(path.node.body)])
      );
    }
    path.node.body.body.unshift(d);
    path.node.ignore = true; // I'm not sure why it would re-enter the functiondecl/expr, but it has happened before

    if (path.node.type === "FunctionExpression") {
      path.replaceWith(createOperation("fn", [path.node], null, path.node.loc));
    }
  }

  const visitors = {
    FunctionDeclaration(path) {
      handleFunction(path);
    },

    FunctionExpression(path) {
      handleFunction(path);
    },

    ArrowFunctionExpression(path) {
      handleFunction(path);
    },

    ClassMethod(path) {
      handleFunction(path);
    },

    ObjectPattern(path) {
      // debugger;
      const newProperties: any[] = [];
      path.node.properties.forEach(prop => {
        let varName;
        if (prop.value && prop.value.type === "Identifier") {
          varName = prop.value.name;
        } else if (prop.value && prop.value.type === "AssignmentPattern") {
          varName = prop.value.left.name;
        } else if (prop.type === "RestElement") {
          varName = prop.argument.name;
        } else {
          varName = prop.key.name;
        }

        // tracking values need to be at the top level, otherwise we'd have to modify the
        // return value of provideObjectPatternTrackingValues which could
        // mean the program ends up with a modified value
        let topLevelObjectPattern = path.node;
        let currentPath = path.parentPath;
        while (currentPath) {
          if (currentPath.node.type === "ObjectPattern") {
            topLevelObjectPattern = currentPath.node;
          }
          currentPath = currentPath.parentPath;
        }

        let topLevelObjectPatternProperties =
          topLevelObjectPattern === path.node
            ? newProperties
            : topLevelObjectPattern.properties;

        let trackingVarPath = skipPath(
          t.ObjectProperty(
            ignoreNode(getTrackingIdentifier(varName)),
            t.assignmentPattern(
              getTrackingIdentifier(varName),
              ignoredCallExpression(FunctionNames.getEmptyTrackingInfo, [
                ignoredStringLiteral("objectPattern"),
                getLocObjectASTNode(prop.loc)
              ])
            )
          )
        );

        const lastTopLevelObjectProperty =
          topLevelObjectPatternProperties[
            topLevelObjectPatternProperties.length - 1
          ];
        const topLevelHasRestElement =
          lastTopLevelObjectProperty &&
          lastTopLevelObjectProperty.type === "RestElement";

        if (!topLevelHasRestElement) {
          topLevelObjectPatternProperties.push(trackingVarPath);
        } else {
          topLevelObjectPatternProperties.splice(
            topLevelObjectPatternProperties.length - 2,
            0,
            trackingVarPath
          );
        }

        newProperties.push(prop);
      });
      path.node.properties = newProperties;
    },

    ForOfStatement(path) {
      if (path.node.left.type === "VariableDeclaration") {
        const variableDeclarator = path.node.left.declarations[0];
        let varKind = "let";
        if (path.node.left.kind === "var") {
          // should leak into parent scope
          varKind = "var";
        }
        if (variableDeclarator.id.type === "Identifier") {
          if (path.node.body.type !== "BlockStatement") {
            path.node.body = ignoreNode(
              babel.types.blockStatement([path.node.body])
            );
          }

          path.node.body.body.unshift(
            skipPath(
              t.variableDeclaration(varKind, [
                t.variableDeclarator(
                  ignoredIdentifier(
                    getTrackingVarName(variableDeclarator.id.name)
                  ),
                  ignoredCallExpression(FunctionNames.getEmptyTrackingInfo, [
                    ignoredStringLiteral("forOfVariable"),
                    getLocObjectASTNode(variableDeclarator.loc)
                  ])
                )
              ])
            )
          );
        }
      }
    },

    VariableDeclaration(path) {
      if (["ForInStatement", "ForOfStatement"].includes(path.parent.type)) {
        return;
      }
      var originalDeclarations = path.node.declarations;
      var newDeclarations: any[] = [];

      originalDeclarations.forEach(function(decl) {
        newDeclarations.push(decl);
        if (!decl.init) {
          decl.init = addLoc(ignoredIdentifier("undefined"), decl.loc);
        }

        if (decl.id.type === "ArrayPattern") {
          // declaration are inserted into pattern already
        } else if (decl.id.type === "ObjectPattern") {
          // declarations are inserted into object pattern already
          // but we need to make sure they are provided

          function getProps(propsArr, pathPrefix = "") {
            let properties: {
              name: string;
              path: string;
              isRest?: boolean;
            }[] = [];
            for (const prop of propsArr) {
              if (prop.type === "RestElement") {
                // for now just ignore and don't add tracking values
                properties.push({
                  name: prop.argument.name,
                  path: pathPrefix + prop.argument.name,
                  isRest: true
                });
              } else if (prop.value.type === "ObjectPattern") {
                properties = [
                  ...properties,
                  ...getProps(
                    prop.value.properties,
                    pathPrefix + prop.key.name + "."
                  )
                ];
              } else if (prop.value.type === "AssignmentPattern") {
                // for now just ignore and don't add tracking values
              } else {
                properties.push({
                  name: prop.value.name,
                  path: pathPrefix + prop.key.name
                });
              }
            }
            return properties;
          }
          let properties = getProps(decl.id.properties);

          decl.init = ignoredCallExpression(
            FunctionNames.provideObjectPatternTrackingValues,
            [
              decl.init,
              ignoredArrayExpression(
                properties.map(prop => {
                  let arrItems = [
                    ignoredStringLiteral(prop.name),
                    ignoredStringLiteral(prop.path)
                  ];
                  if (prop.isRest) {
                    arrItems.push(ignoredStringLiteral("isRest"));
                  }
                  return ignoredArrayExpression(arrItems);
                })
              )
            ]
          );
        } else {
          newDeclarations.push(
            t.variableDeclarator(
              addLoc(getTrackingIdentifier(decl.id.name), decl.id.loc),
              skipPath(
                t.callExpression(
                  t.identifier(FunctionNames.getLastOperationTrackingResult),
                  []
                )
              )
            )
          );
        }
      });

      path.node.declarations = newDeclarations;
    },

    WithStatement(path) {
      function i(node) {
        if (node.name === null) {
          debugger;
        }
        node.ignoreInWithStatementVisitor = true;
        return node;
      }

      // not an ideal way to track things and might not work for nested
      // with statements, but with statement use should be rare.
      // Underscore uses them for templates though.
      let obj = path.node.object;
      path.get("object").traverse({
        Identifier(path) {
          path.replaceWith(i(path.node));
        }
      });
      path.traverse({
        Identifier(path) {
          if (path.node.ignoreInWithStatementVisitor) {
            return;
          }
          if (shouldSkipIdentifier(path)) {
            return;
          }
          if (
            ["WithStatement", "FunctionExpression"].includes(path.parent.type)
          ) {
            return;
          }
          if (path.parent.type === "MemberExpression") {
            if ((path.parent.property = path.node)) {
              console.log("ignoreing");
              return;
            }
          }
          path.node.ignoreInWithStatementVisitor = true;

          const identifierName = path.node.name;
          path.replaceWith(
            ignoreNode(
              t.conditionalExpression(
                ignoreNode(
                  t.binaryExpression(
                    "in",
                    addLoc(t.stringLiteral(identifierName), path.node.loc),
                    obj
                  )
                ),
                addLoc(
                  t.memberExpression(
                    obj,
                    addLoc(t.stringLiteral(identifierName), path.node.loc),
                    true
                  ),
                  path.node.loc
                ),
                i(addLoc(t.identifier(identifierName), path.node.loc))
              )
            )
          );
        }
      });
    },

    CatchClause(path) {
      const errName = path.node.param.name;
      // We don't track anything, but this var has to exist to avoid "err___tv is undeclared" errors
      const trackingVarDec = skipPath(
        t.variableDeclaration("let", [
          t.variableDeclarator(t.identifier(getTrackingVarName(errName)))
        ])
      );
      path.node.body.body.unshift(trackingVarDec);
    },

    ArrayPattern(path) {
      const isForOfStatementWithVarDeclaration =
        path.parentPath.node.type === "VariableDeclarator" &&
        path.parentPath.parentPath.parentPath.node.type === "ForOfStatement";
      const isForOfStatementWithoutVarDeclaration =
        path.parentPath.node.type === "ForOfStatement";

      if (
        [
          "FunctionDeclaration",
          "FunctionExpression",
          "ArrowFunctionExpression"
        ].includes(path.parentPath.node.type)
      ) {
        // don't transform, it would break how the values are passed
        return;
      }

      const specificParamCount = path.node.elements.filter(el => {
        // !el if e.g. [,a,b] with an empty item at the start
        return !el || el.type !== "RestElement";
      }).length;

      if (
        isForOfStatementWithVarDeclaration ||
        isForOfStatementWithoutVarDeclaration
      ) {
        let forOfStatement;
        if (isForOfStatementWithVarDeclaration) {
          forOfStatement = path.parentPath.parentPath.parentPath.node;
        } else if (isForOfStatementWithoutVarDeclaration) {
          forOfStatement = path.parentPath.node;
        }

        forOfStatement.right = ignoredCallExpression(
          FunctionNames.expandArrayForArrayPattern,
          [
            forOfStatement.right,
            getLocObjectASTNode(forOfStatement.loc),
            ignoredStringLiteral("forOf"),
            ignoredNumericLiteral(specificParamCount)
          ]
        );
      } else if (
        path.parentPath.parentPath.node.type === "VariableDeclaration"
      ) {
        const declarator = path.parentPath.node;
        declarator.init = ignoredCallExpression(
          FunctionNames.expandArrayForArrayPattern,
          [
            declarator.init,
            getLocObjectASTNode(declarator.loc),
            ignoredStringLiteral("variableDeclarationInit"),
            ignoredNumericLiteral(specificParamCount)
          ]
        );
      } else if (path.parentPath.node.type === "AssignmentExpression") {
        const assignmentExpression = path.parentPath.node;
        assignmentExpression.right = ignoredCallExpression(
          FunctionNames.expandArrayForArrayPattern,
          [
            assignmentExpression.right,
            getLocObjectASTNode(assignmentExpression.loc),
            ignoredStringLiteral("assignmentExpressionRight"),
            ignoredNumericLiteral(specificParamCount)
          ]
        );
      }

      const arrayPattern = path.node;
      const newElements: any[] = [];
      arrayPattern.elements.forEach(elem => {
        let varName;
        if (!elem) {
        } else if (elem.type === "Identifier") {
          varName = elem.name;
        } else if (elem.type === "AssignmentPattern") {
          varName = elem.left.name;
        } else if (elem.type === "RestElement") {
          varName = elem.argument.name;
        } else if (elem.type === "ObjectPattern") {
          // will be processed in ObjectPattern visitor
        } else {
          throw Error("array pattern elem type " + elem.type);
        }
        if (!elem) {
          newElements.push(elem);
          newElements.push(elem);
        } else if (elem.type !== "RestElement") {
          newElements.push(elem);
          newElements.push(addLoc(getTrackingIdentifier(varName), elem.loc));
        } else {
          // Rest element must be last element
          newElements.push(addLoc(getTrackingIdentifier(varName), elem.loc));
          newElements.push(elem.argument);
        }
        // newDeclarations.push(
        //   t.variableDeclarator(
        //     ,
        //     skipPath(
        //       ignoredCallExpression(FunctionNames.getEmptyTrackingInfo, [
        //         ignoredStringLiteral("arrayPatternInVarDeclaration"),
        //         getLocObjectASTNode(elem.loc)
        //       ])
        //     )
        //   )
        // );
      });
      arrayPattern.elements = newElements;
    },

    ForInStatement(path) {
      let varName;
      let isNewVariable;
      let varKind = "let";
      if (path.node.left.type === "VariableDeclaration") {
        const variableDeclaration = path.node.left;
        varName = variableDeclaration.declarations[0].id.name;
        if (variableDeclaration.kind === "var") {
          // should leak into outer scope
          varKind = "var";
        }
        isNewVariable = true;
      } else if (path.node.left.type === "Identifier") {
        varName = path.node.left.name;
        isNewVariable = false;
      } else {
        throw Error("not sure what this is");
      }

      if (path.node.body.type !== "BlockStatement") {
        // Technically it might not be safe to make this conversion
        // because it affects scoping for let/const inside the body
        // ...although that's not usually what you do inside a for in body
        path.node.body = ignoreNode(
          babel.types.blockStatement([path.node.body])
        );
      }

      const body = path.node.body.body;

      let forInRightValueIdentifier = ignoreNode(
        path.scope.generateUidIdentifier("__forInRightVal")
      );

      // insertBefore causes this ForInStatement to be visited again
      // if a block body is introduced for the parent (e.g. if the parent
      // was a single-statement if statement before)
      // Prevent processing this ForInStatement twice
      path.node.ignore = true;

      path.insertBefore(
        ignoreNode(
          t.variableDeclaration("let", [
            t.variableDeclarator(forInRightValueIdentifier, path.node.right)
          ])
        )
      );

      path.node.right = forInRightValueIdentifier;

      var assignment = ignoreNode(
        t.expressionStatement(
          ignoreNode(
            t.assignmentExpression(
              "=",
              ignoredIdentifier(getTrackingVarName(varName)),
              ignoredCallExpression(
                FunctionNames.getObjectPropertyNameTrackingValue,
                [forInRightValueIdentifier, ignoredIdentifier(varName)]
              )
            )
          )
        )
      );
      body.unshift(assignment);

      if (isNewVariable) {
        var declaration = ignoreNode(
          // Note: this needs to be let or else there could be conflict with
          // a var from parent scope
          t.variableDeclaration(varKind, [
            t.variableDeclarator(ignoredIdentifier(getTrackingVarName(varName)))
          ])
        );
        body.unshift(declaration);
      }
    }
  };

  Object.keys(operations).forEach(key => {
    var operation = operations[key];
    key = key[0].toUpperCase() + key.slice(1);
    if (operation.visitor) {
      if (visitors[key]) {
        throw Error("duplicate visitor " + key);
      }
      visitors[key] = path => {
        var ret = operation.visitor.call(operation, path);
        if (ret) {
          if (!ret.loc) {
            // debugger;
          }
          try {
            path.replaceWith(ret);
          } catch (err) {
            console.log("Error for path at loc", JSON.stringify(path.node.loc));
            // for easier debugging, allow step in again
            debugger;
            operation.visitor.call(operation, path);
            throw err;
          }
        }
      };
    }
  });

  // var enter = 0;
  // var enterNotIgnored = 0;

  Object.keys(visitors).forEach(key => {
    var originalVisitor = visitors[key];
    visitors[key] = function(path) {
      // enter++;
      if (path.node.skipPath) {
        path.skip();
        return;
      }
      if (path.node.skipKeys) {
        path.skipKeys = path.node.skipKeys;
        return;
      }
      if (path.node.ignore) {
        return;
      }
      // enterNotIgnored++;
      return originalVisitor.apply(this, arguments);
    };
  });

  visitors["Program"] = {
    // Run on exit so injected code isn't processed by other babel plugins
    exit: function(path) {
      const babelPluginOptions = plugin["babelPluginOptions"];
      let usableHelperCode;

      if (babelPluginOptions) {
        const {
          accessToken,
          backendPort,
          backendOriginWithoutPort
        } = babelPluginOptions;
        usableHelperCode = helperCode;
        usableHelperCode = usableHelperCode.replace(
          /ACCESS_TOKEN_PLACEHOLDER/g,
          accessToken
        );
        usableHelperCode = usableHelperCode.replace(
          /BACKEND_PORT_PLACEHOLDER/g,
          backendPort
        );
        usableHelperCode = usableHelperCode.replace(
          /BACKEND_ORIGIN_WITHOUT_PORT_PLACEHOLDER/g,
          backendOriginWithoutPort
        );
      } else {
        usableHelperCode = helperCode;
      }

      // console.log({ enter, enterNotIgnored });

      var initCodeAstNodes = babylon
        .parse(usableHelperCode)
        .program.body.reverse();
      initCodeAstNodes.forEach(node => {
        path.node.body.unshift(node);
      });
    }
  };

  return {
    name: "fromjs-babel-plugin",
    visitor: visitors
  };
}

export default plugin;
