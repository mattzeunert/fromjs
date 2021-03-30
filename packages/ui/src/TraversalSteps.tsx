import { branch, root } from "baobab-react/higher-order";
import * as React from "react";
import TraversalStep from "./TraversalStep";
import * as cx from "classnames";
import { toggleShowFullDataFlow, toggleShowDOMStep } from "./actions";
import ItemWithTitle from "./ItemWithTitle";
import { ErrorBoundary } from "./ErrorBoundary";

type TraversalStepsProps = {
  steps?: any[];
  inspectionTarget?: any;
  showFullDataFlow?: boolean;
  isTraversing?: boolean;
  inspectedString?: any;
  showDOMStep?: boolean;
};
let TraversalSteps = class TraversalSteps extends React.Component<
  TraversalStepsProps,
  {}
> {
  render() {
    if (!this.props.inspectionTarget) {
      return <div>No tracking data available or still loading.</div>;
    }

    if (this.props.inspectionTarget.error) {
      return <div>{this.props.inspectionTarget.error}</div>;
    }

    if (!this.props.inspectionTarget.logId) {
      return <div>No tracking data available or still loading.</div>;
    }

    if (!this.props.inspectedString) {
      return <div>no inspected string</div>;
    }

    const inspectedStringType = this.props.inspectedString.type;
    let stepsToShow = [];
    let steps = this.props.steps;
    if (!steps.length) {
      if (this.props.isTraversing) {
        return <div style={{ marginTop: 10 }}>Loading...</div>;
      } else {
        return null;
      }
    }

    stepsToShow = steps;

    const interestingSteps = [];
    let previousStep = steps[0];
    for (var i = 1; i < steps.length - 1; i++) {
      const step = steps[i];
      const previousStepCriteria = getStepInterestingnessCriteria(previousStep);
      const stepCriteria = getStepInterestingnessCriteria(step);

      if (step.operationLog.operation === "jsonParseResult") {
        // debugger;
      }
      if (
        previousStepCriteria.charsAfter !== stepCriteria.charsAfter ||
        previousStepCriteria.charsBefore !== stepCriteria.charsBefore
      ) {
        interestingSteps.push(step);
      }
      previousStep = step;
    }

    function getStepInterestingnessCriteria(step) {
      let str = step.operationLog.result.getTruncatedUIString();

      let charIndexTwoCharsBefore = step.charIndex - 2;
      if (charIndexTwoCharsBefore < 0) {
        charIndexTwoCharsBefore = 0;
      }
      let charIndexTwoCharsAfter = step.charIndex + 2;
      if (charIndexTwoCharsAfter > str.length - 1) {
        charIndexTwoCharsAfter = str.length - 1;
      }
      return {
        charsBefore: str.slice(charIndexTwoCharsBefore, step.charIndex),
        charsAfter: str.slice(step.charIndex, charIndexTwoCharsAfter)
      };
    }

    let mainSteps = [];

    mainSteps.push(stepsToShow[0]);

    window.__debugSteps = steps;
    steps.slice(0, -1).forEach((s, i) => {
      let stepCloserToInspectedValue = steps[i + 1];
      let stepCloserToValueOrigin = steps[i - 1];

      let isMemberAccessForParsedJson =
        s.operationLog.operation === "memberExpression" &&
        steps[i + 1] &&
        steps[i + 1].operationLog.operation === "jsonParseResult";

      // E.g. if we make an optimistic traversal of a number
      // we want to show the last previous number before it was modified
      let charWillChange =
        stepCloserToValueOrigin &&
        stepCloserToValueOrigin.chars[1] !== s.chars[1];

      let isMainStep =
        isMemberAccessForParsedJson ||
        s.operationLog.operation === "stringLiteral" ||
        charWillChange;

      if (isMainStep) {
        if (!mainSteps.find(ms => ms === s)) {
          mainSteps.push(s);
        }
      }
    });

    return (
      <div style={{ opacity: this.props.isTraversing ? 0.5 : 1, padding: 10 }}>
        <ItemWithTitle>
          <div>Value origin</div>
          <div>
            <ErrorBoundary>
              <TraversalStep
                key={steps[steps.length - 1].operationLog.index}
                step={steps[steps.length - 1]}
              />
            </ErrorBoundary>
          </div>
        </ItemWithTitle>

        {mainSteps && (
          <div style={{ marginTop: 20 }}>
            {mainSteps
              .map(step => (
                <div style={{ marginBottom: 10 }}>
                  <ErrorBoundary>
                    <TraversalStep
                      key={step.operationLog.index}
                      step={step}
                      defaultCodeSurroundingLineCount={1}
                    />
                  </ErrorBoundary>
                </div>
              ))
              .reverse()}
          </div>
        )}
        {/* <div
          className={cx("named-step-container", {
            "named-step-container--collapsed": !this.props.collapseDomInspector
          })}
        >
          <div className="title">
            Inspected JS string
            {this.props.collapseDomInspector
              ? " (click a character to view its origin)"
              : ""}:
            {!this.props.collapseDomInspector && (
              <button
                style={{ marginLeft: 10, cursor: "pointer" }}
                onClick={() => collapseDomInspector()}
              >
                Click to show
              </button>
            )}
          </div>
          {this.props.collapseDomInspector && (
            <TraversalStep key={steps[0].operationLog.index} step={steps[0]} />
          )}
        </div> */}
        {/* <hr />
        <hr />
        <div>Relevant code:</div>
        {interestingSteps.map(step => (
          <TraversalStep key={step.operationLog.index} step={step} />
        ))
        } */}
        <div style={{ height: 10 }} />

        {/* not really needed any more since it'll be shown by default */}
        {/* {inspectedStringType === "dom" &&
          !this.props.showDOMStep &&
          !this.props.showFullDataFlow && (
            <button
              className="step__visible-steps-button"
              onClick={() => {
                toggleShowDOMStep(true);
              }}
            >
              Show DOM transition step
            </button>
          )} */}
        {!this.props.showFullDataFlow &&
          !this.props.showDOMStep &&
          steps.length > 1 && (
            <button
              onClick={() => toggleShowFullDataFlow(true)}
              className="step__visible-steps-button"
            >
              Show full data flow ({steps.length} steps)
            </button>
          )}
        {this.props.showDOMStep && (
          <ErrorBoundary>
            <TraversalStep step={stepsToShow[0]} />
          </ErrorBoundary>
        )}

        {(this.props.showFullDataFlow || this.props.showDOMStep) && (
          <button
            className="step__visible-steps-button"
            style={{ marginTop: 10, marginBottom: 10 }}
            onClick={() => {
              toggleShowFullDataFlow(false);
              toggleShowDOMStep(false);
            }}
          >
            Show less
          </button>
        )}

        {this.props.showFullDataFlow && (
          <div
            className="title"
            style={{
              cursor: "pointer"
            }}
          >
            Full data flow – the story of how the selected string was
            constructed:
          </div>
        )}

        {this.props.showFullDataFlow &&
          stepsToShow
            .map(step => (
              <div style={{ marginBottom: 10 }}>
                <ErrorBoundary>
                  <TraversalStep key={step.operationLog.index} step={step} />
                </ErrorBoundary>
              </div>
            ))
            .reverse()}
      </div>
    );
  }
};

TraversalSteps = branch(
  {
    debugMode: ["debugMode"],
    steps: ["steps"],
    inspectionTarget: ["inspectionTarget"],
    inspectedString: ["inspectedString"],
    showFullDataFlow: ["showFullDataFlow"],
    showDOMStep: ["showDOMStep"],
    isTraversing: ["hasInProgressRequest", "traverse"]
  },
  TraversalSteps
);

export default TraversalSteps;
