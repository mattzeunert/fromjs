import appState from "./appState";
import { inspectDomChar, loadSteps } from "./api";
import { debounce, last } from "lodash";

export function traverse() {
  appState.set("steps", []);
  const inspectionTarget = appState.get("inspectionTarget");
  if (!inspectionTarget || !inspectionTarget.logId) {
    console.log("no inspection target!!");
  } else {
    console.time("Load Steps");
    loadSteps(inspectionTarget).then(r => {
      console.timeEnd("Load Steps");
      var steps = r.steps;
      console.log({ steps });

      appState.set("steps", steps);
    });
  }
}

let isUndoing = false;
let onSelectionChange = function() {
  if (isUndoing) {
    return;
  }
  const selectionInfo = {
    inspectionTarget: appState.get("inspectionTarget"),
    domToInspect: appState.get("domToInspect")
  };
  appState.set("selectionHistory", [
    ...appState.get("selectionHistory"),
    selectionInfo
  ]);
};
// debounce to merge inspectiontarget and domtoinspect changes
onSelectionChange = debounce(onSelectionChange, 20);
appState.select("inspectionTarget").on(onSelectionChange);
appState.select("domToInspect").on(onSelectionChange);

export function undoSelection() {
  let selectionHistory = appState.get("selectionHistory");
  selectionHistory = selectionHistory.slice(0, -1);
  let selection = last(selectionHistory);
  appState.set("selectionHistory", selectionHistory);

  isUndoing = true;
  setSelection(selection);
  setTimeout(() => (isUndoing = false), 100);
}

export function setSelection({ inspectionTarget, domToInspect }) {
  appState.set("inspectionTarget", inspectionTarget);
  appState.set("domToInspect", domToInspect);
  traverse();
}

export function selectAndTraverse(logId, charIndex, origin?) {
  if (origin === "traversalStep") {
    // this is bad! need to clean up how the state works at some point
    appState.set("domToInspect", null);
  }
  appState.set("inspectionTarget", { logId, charIndex });
  traverse();
}
window["selectAndTraverse"] = selectAndTraverse;

export function selectInspectedDomCharIndex(charIndex) {
  appState.set(["domToInspect", "charIndex"], charIndex);
  inspectDomChar(charIndex).then(({ logId, charIndex }) => {
    debugger;
    if (logId) {
      appState.set("inspectionTarget", { logId, charIndex });
      traverse();
    } else {
      appState.set("inspectionTarget", { error: "No DOM tracking info" });
    }
  });
}

export function setIsInspectingDemoApp(isInspecting) {
  appState.set("isInspectingDemoApp", isInspecting);
}

export function toggleShowFullDataFlow(showFullDataFlow) {
  appState.set("showFullDataFlow", showFullDataFlow);
}

export function toggleShowDOMStep(showDOMStep) {
  appState.set("showDOMStep", showDOMStep);
}

export function setCollapseGetStartedIfHasData(collapse) {
  appState.set("collapseGetStartedIfHasData", collapse);
}

export function setPrettifyIfNoSourceMap(prettify) {
  appState.set("prettifyIfNoSourceMap", prettify);
  window["forceUpdateInspector"]();
}
