import { spawn } from "child_process";
const kp = require("kill-port");
const request = require("request");
import { OperationLog } from "@fromjs/core";
import { openBrowser } from "@fromjs/backend";
var rimraf = require("rimraf");

async function killPort(portNum) {
  try {
    await kp(portNum);
  } catch (err) {
    console.log(
      "Continuing after killPort error",
      err.message.slice(0, 200) + "..."
    );
  }
}

const backendPort = 12100;
const webServerPort = backendPort + 1;

export async function saveScreenshot(page, screenshotName) {
  await page.screenshot({
    path: "artifacts/" + screenshotName + ".png"
  });
}

function setTimeoutPromise(timeout) {
  return new Promise(resolve => {
    setTimeout(resolve, timeout);
  });
}

function waitForProxyReady(command) {
  return new Promise(resolve => {
    command.stdout.on("data", function(data) {
      if (data.toString().includes("Server listening")) {
        resolve();
      }
    });
  });
}

function startWebServer() {
  return new Promise(resolve => {
    let command = spawn(__dirname + "/node_modules/.bin/http-server", [
      "-p",
      webServerPort.toString(),
      __dirname
    ]);
    command.stdout.on("data", function(data) {
      if (data.toString().includes("Hit CTRL-C to stop the server")) {
        resolve();
      }
    });
    command.stderr.on("data", function(data) {
      console.log("err", data.toString());
    });
  });
}

function inspectDomChar(pageSessionId, charIndex) {
  return new Promise(resolve => {
    request.post(
      {
        url: "http://localhost:" + backendPort + "/inspectDomChar",
        json: {
          charIndex,
          pageSessionId
        },
        rejectUnauthorized: false
      },
      function(err, resp, body) {
        if (err) {
          throw Error(err);
        }
        resolve(body);
      }
    );
  });
}

function traverse(firstStep) {
  return new Promise(resolve => {
    request.get(
      {
        url: `http://localhost:${backendPort}/traverse?logId=${
          firstStep.logId
        }&charIndex=${firstStep.charIndex}&keepResultData=true`,
        rejectUnauthorized: false,
        json: true
      },
      function(err, resp, body) {
        if (err) {
          throw Error(err);
        }
        resolve(body);
      }
    );
  });
}

async function waitForSelectedChar(inspectorPage, char) {
  await inspectorPage.waitFor(
    char => {
      const e = document.querySelector(
        ".named-step-container .fromjs-highlighted-character"
      );
      return e && e!.textContent === char;
    },
    {},
    char
  );
}

async function inspectDomCharAndTraverse(
  pageSessionId: string,
  charIndex: number,
  isSecondTry = false
) {
  try {
    if (charIndex === -1) {
      throw Error("char index is -1");
    }
    const firstStep = await inspectDomChar(pageSessionId, charIndex);
    if (typeof firstStep === "string") {
      console.log(firstStep);
      throw Error("Seems like no tracking data ");
    }
    const res = (await traverse(firstStep)) as any;
    const steps = res["steps"];
    const lastStep = steps[steps.length - 1];
    return {
      charIndex: lastStep.charIndex,
      operationLog: new OperationLog(lastStep.operationLog)
    };
  } catch (err) {
    if (isSecondTry) {
      throw err;
    } else {
      await setTimeoutPromise(2000);
      return await inspectDomCharAndTraverse(pageSessionId, charIndex, true);
    }
  }
}

describe("E2E", () => {
  let browser;

  let pages: any[] = [];

  async function createPage() {
    const page = await browser.newPage();
    page.on("pageerror", function(err) {
      console.log("Page error: " + err.toString());
    });
    // wait for the whole redirect to exampel and to /start thing...
    await new Promise(resolve => setTimeout(resolve, 4000));
    pages.push(page);
    return page;
  }

  beforeAll(async () => {
    process.title = "Jest E2E";
    console.log("JEST PID", process.pid);
    await killPort(backendPort);
    await killPort(webServerPort);

    command = spawn(
      __dirname + "/bin/fromjs",
      [
        "--port",
        backendPort.toString(),
        "--openBrowser",
        "no",
        "--sessionDirectory",
        fromJSSessionPath
      ],
      { detached: true }
    );

    command.stdout.on("data", function(data) {
      console.log("CLI out", data.toString());
    });

    command.stderr.on("data", function(data) {
      console.log("CLI err", data.toString());
    });

    await waitForProxyReady(command);

    try {
      console.log("will open browser");
      browser = await openBrowser({
        userDataDir: undefined,
        extraArgs: [
          "--disable-gpu",
          "--no-sandbox",
          "--disable-setuid-sandbox"
        ],
        config: {
          backendPort,
          redirectUrl: "http://example.com"
        }
      });
      await new Promise(resolve => setTimeout(resolve, 3000));
    } catch (err) {
      console.log("FAILed to launch browser", err);
      throw err;
    }

    // browser = await puppeteer.launch({
    //   ignoreHTTPSErrors: true,
    //   dumpio: true,
    //   args: [
    //     // "--proxy-server=127.0.0.1:" + proxyPort,
    //     // To make it work in CI:
    //     "--no-sandbox"
    //   ],
    //   headless: !process.env.HEADFUL,
    //   devtools: process.env.HEADFUL
    // });

    await startWebServer();
  }, 20000);

  afterEach(async () => {
    for (const page of pages) {
      if (page && page.close) {
        await page.close();
      }
    }
    pages = [];
  });

  const fromJSSessionPath = "/tmp/fromjs-e2e";

  afterAll(async () => {
    await browser.close();

    // minus + detached true above makes it kill process group or sth
    process.kill(-command.pid);

    await killPort(webServerPort);
    rimraf.sync(fromJSSessionPath);
    await new Promise(resolve => setTimeout(resolve, 500));
  });

  const inspectorUrl = "http://localhost:" + backendPort + "/";

  async function getLastStepHtml(inspectorPage) {
    await inspectorPage.waitForSelector(".step");
    return inspectorPage.evaluate(
      () => document.querySelectorAll(".step")[0]["innerText"]
    );
  }

  async function waitForLastHTMLStepToContain(inspectorPage, str) {
    await inspectorPage.waitForFunction(
      str => {
        const lastStep = document.querySelectorAll(".step")[0];
        return lastStep && lastStep.innerHTML.includes(str);
      },
      {},
      str
    );
  }

  let command;
  it("Can load the start page", async () => {
    const page = await createPage();

    console.log("creatd page");

    await page.goto("http://localhost:" + backendPort + "/start/");
    console.log("called goto");
    await page.waitForSelector("#fromjs-inspect-dom-button");
    await page.waitForSelector("h1");

    await page.type("[data-test-name-input]", "A");
    await page.waitForFunction(() =>
      document.body.innerHTML.includes("Hi SomeoneA")
    );

    await page.click("#fromjs-inspect-dom-button");
    await page.click("h1");

    const inspector = await waitForInPageInspector(page);
    await inspector.waitForSelector(".step");
    const text = await getLastStepHtml(inspector);
    expect(text).toContain("StringLiteral");

    await page.evaluate(() =>
      document
        .querySelector("[data-test-fun-things] > div:nth-child(2)")!
        ["click"]()
    );

    // wait for it to inspect H first
    await page.waitFor(4000);

    await inspector.waitForFunction(() =>
      document.body.innerText.includes("SomeoneA")
    );
    await inspector.click("[data-key='11']");
    await inspector.waitForFunction(() =>
      document.body.innerText.includes("HTMLInputElementValueGetter")
    );
  }, 60000);

  it("Does DOM to JS tracking", async () => {
    const page = await createPage();
    await page.goto(
      "http://localhost:" + webServerPort + "/tests/domTracking/"
    );
    const testResult = await (await page.waitForFunction(
      'window["testResult"]'
    )).jsonValue();

    const html = testResult.parts.map(p => p[0]).join("");

    let pageSessionId = await page.evaluate(`global["fromJSPageSessionId"]`);

    // createElement

    let res = await inspectDomCharAndTraverse(
      pageSessionId,
      html.indexOf("span")
    );

    expect(res.operationLog.operation).toBe("stringLiteral");
    expect(res.operationLog.result.primitive).toBe("span");

    // createTextNode
    res = await inspectDomCharAndTraverse(
      pageSessionId,
      html.indexOf("createTextNode")
    );
    expect(res.operationLog.operation).toBe("stringLiteral");
    expect(res.operationLog.result.primitive).toBe("createTextNode");

    // createComment
    res = await inspectDomCharAndTraverse(
      pageSessionId,
      html.indexOf("createComment")
    );
    expect(res.operationLog.operation).toBe("stringLiteral");
    expect(res.operationLog.result.primitive).toBe("createComment");

    // Initial page html
    res = await inspectDomCharAndTraverse(
      pageSessionId,
      html.indexOf("InitialPageHtml")
    );
    expect(res.operationLog.operation).toBe("initialPageHtml");
    expect(res.operationLog.result.primitive).toContain(`<div id="app"`);

    // Values read from script tags in initial html
    res = await inspectDomCharAndTraverse(
      pageSessionId,
      html.indexOf("scriptTagContent")
    );
    expect(res.operationLog.operation).toBe("initialPageHtml");
    expect(res.operationLog.result.primitive).toContain(`<div id="app"`);
    const fullPageHtml = require("fs")
      .readFileSync(__dirname + "/tests/domTracking/index.html")
      .toString();
    expect(res.charIndex).toBe(fullPageHtml.indexOf("scriptTagContent"));

    // setAttribute
    const spanHtml = '<span attr="setAttribute">abc<b>innerHTML</b></span>';
    // Calculate indices withhin because attr="setAttribute" is also used by cloned node later on
    const spanIndex = html.indexOf(spanHtml);
    const attrNameIndex = spanIndex + spanHtml.indexOf("attr=");
    const attrValueIndex = spanIndex + spanHtml.indexOf("setAttribute");
    res = await inspectDomCharAndTraverse(pageSessionId, attrValueIndex);
    expect(res.operationLog.operation).toBe("stringLiteral");
    expect(res.operationLog.result.primitive).toBe("setAttribute");

    res = await inspectDomCharAndTraverse(pageSessionId, attrNameIndex);
    expect(res.operationLog.operation).toBe("stringLiteral");
    expect(res.operationLog.result.primitive).toBe("attr");

    // innerHTML
    res = await inspectDomCharAndTraverse(pageSessionId, html.indexOf("<b>"));
    expect(res.operationLog.operation).toBe("stringLiteral");
    expect(res.operationLog.result.primitive).toBe("abc<b>innerHTML</b>");

    // Comment in innerHTML
    res = await inspectDomCharAndTraverse(
      pageSessionId,
      html.indexOf("<!-- COMMENT_IN_INNERTHML -->")
    );
    expect(res.operationLog.operation).toBe("stringLiteral");
    expect(res.operationLog.result.primitive).toBe(
      "<!-- COMMENT_IN_INNERTHML -->"
    );

    // insertAjacentHTML
    res = await inspectDomCharAndTraverse(
      pageSessionId,
      html.indexOf("insertAdjacentHTML2")
    );
    expect(res.operationLog.operation).toBe("stringLiteral");
    expect(res.operationLog.result.primitive).toBe(
      "<div>insertAdjacentHTML1</div><div>insertAdjacentHTML2</div>"
    );

    // setting a.href
    res = await inspectDomCharAndTraverse(pageSessionId, html.indexOf("aHref"));
    expect(res.operationLog.operation).toBe("stringLiteral");
    expect(res.operationLog.result.primitive).toBe("aHref");

    // DOMParser parseFromString
    res = await inspectDomCharAndTraverse(
      pageSessionId,
      html.indexOf("DOMParser")
    );
    expect(res.operationLog.operation).toBe("stringLiteral");
    expect(res.operationLog.result.primitive).toBe("<div>DOMParser</div>");

    // textContent
    res = await inspectDomCharAndTraverse(
      pageSessionId,
      html.indexOf("textContent")
    );
    expect(res.operationLog.operation).toBe("stringLiteral");
    expect(res.operationLog.result.primitive).toBe("textContent");

    // textContent
    res = await inspectDomCharAndTraverse(
      pageSessionId,
      html.indexOf("className") - '">'.length
    );
    expect(res.operationLog.operation).toBe("stringLiteral");
    expect(res.operationLog.result.primitive).toBe("someClass");

    // setting el.style.sth
    res = await inspectDomCharAndTraverse(
      pageSessionId,
      html.indexOf("styleWidth") - '">'.length
    );
    expect(res.operationLog.operation).toBe("stringLiteral");
    expect(res.operationLog.result.primitive).toBe("50px");

    // cloneNode
    const clonedSpanHtml =
      '<span attr="setAttribute">cloneNode<!--createComment-->createTextNode<div><div>deepClonedContent</div></div></span>';
    const clonedSpanIndex = html.indexOf(clonedSpanHtml);
    const clonedSpanAttributeIndex =
      clonedSpanIndex + clonedSpanHtml.indexOf("attr=");
    const clonedTextIndex =
      clonedSpanIndex + clonedSpanHtml.indexOf("createTextNode");
    const clonedCommentIndex =
      clonedSpanIndex + clonedSpanHtml.indexOf("createComment");
    const deepClonedContentIndex =
      clonedSpanIndex + clonedSpanHtml.indexOf("deepClonedContent");

    res = await inspectDomCharAndTraverse(pageSessionId, clonedSpanIndex);
    expect(res.operationLog.operation).toBe("stringLiteral");
    expect(res.operationLog.result.primitive).toBe("span");

    res = await inspectDomCharAndTraverse(
      pageSessionId,
      clonedSpanAttributeIndex
    );
    expect(res.operationLog.operation).toBe("stringLiteral");
    expect(res.operationLog.result.primitive).toBe("attr");

    res = await inspectDomCharAndTraverse(pageSessionId, clonedTextIndex);
    expect(res.operationLog.operation).toBe("stringLiteral");
    expect(res.operationLog.result.primitive).toBe("createTextNode");

    res = await inspectDomCharAndTraverse(pageSessionId, clonedCommentIndex);
    expect(res.operationLog.operation).toBe("stringLiteral");
    expect(res.operationLog.result.primitive).toBe("createComment");

    res = await inspectDomCharAndTraverse(
      pageSessionId,
      deepClonedContentIndex
    );
    expect(res.operationLog.operation).toBe("stringLiteral");
    expect(res.operationLog.result.primitive).toBe(
      "<div>deepClonedContent</div>"
    );

    // template + importNode
    res = await inspectDomCharAndTraverse(
      pageSessionId,
      html.indexOf("TemplateChild2")
    );
    expect(res.operationLog.operation).toBe("initialPageHtml");

    // .text or .textContent on a text node
    res = await inspectDomCharAndTraverse(
      pageSessionId,
      html.indexOf("nodeNodeValueAssignment")
    );
    expect(res.operationLog.operation).toBe("stringLiteral");
    expect(res.operationLog.result.primitive).toBe("nodeNodeValueAssignment");
  }, 30000);

  it("Can inspect backbone todomvc and select an element by clicking on it", async () => {
    // Load inspected page
    const page = await createPage();
    await page.goto("http://localhost:8000/examples/backbone/");
    await page.waitForSelector(".todo-list li", { timeout: 60000 });

    // Select label for inspection
    await page.waitForSelector("#fromjs-inspect-dom-button");
    await page.click("#fromjs-inspect-dom-button");
    await page.waitForFunction(
      "document.querySelector('#fromjs-inspect-dom-button').innerText.includes('Click')"
    );
    await page.click(".todo-list li label");

    console.log("will wait for inpspector");
    const inspectorPage = await waitForInPageInspector(page);

    console.log("will wait for localstorage.getItem");
    // Todo name should come from local storage
    await inspectorPage.waitForFunction(() =>
      document.body.innerHTML.includes("localStorage.getItem")
    );

    // label tag should map to initial page html
    await inspectorPage.click(".fromjs-value__content [data-key='1']");
    await inspectorPage.waitForFunction(() =>
      document.body.innerHTML.includes("InitialPageHtml")
    );
    await waitForSelectedChar(inspectorPage, "l");
  }, 90000);

  it("Can inspect pre-compiled react todomvc and use in-page inspection UI", async () => {
    // Load inspected page
    const page = await createPage();
    await page.goto("http://localhost:8000/react-todomvc-compiled/#/");
    await page.waitForSelector(".todo-list li", { timeout: 60000 });

    // Select label for inspection
    await page.waitForSelector("#fromjs-inspect-dom-button");
    await page.click("#fromjs-inspect-dom-button");
    await page.waitForFunction(
      "document.querySelector('#fromjs-inspect-dom-button').innerText.includes('Click')",
      { timeout: 60000 }
    );
    await page.click(".todo-list li label");

    console.log("wait for in page inspector");
    const inspectorFrame = await waitForInPageInspector(page);
    await page.waitFor(2000);
    await saveScreenshot(page, "waited-for-inspector-plus-2s");

    console.log("wait for localStorage.getItem");

    // Todo name should come from local storage
    await inspectorFrame.waitForFunction(() =>
      document.body.innerHTML.includes("localStorage.getItem")
    );
    await saveScreenshot(page, "waited-for-localstorage");

    console.log("wait for stringLiteral");

    // Origin of label
    inspectorFrame.click(".fromjs-value__content [data-key='3']");
    await inspectorFrame.waitForFunction(() =>
      document.body.innerHTML.includes("StringLiteral")
    );
  }, 90000);

  it("Can inspect XMLHttpRequest result", async () => {
    const page = await createPage();

    await page.goto(
      "http://localhost:" + webServerPort + "/tests/" + "XMLHttpRequest/"
    );
    const inspector = await waitForInPageInspector(page);

    console.log("wait for xmlhttpreq resp text");
    // note: at first the last html step still shows data from the previous test
    await waitForLastHTMLStepToContain(
      inspector,
      "XMLHttpRequest.responseText"
    );
    console.log("will inspect url arg");

    await inspector.waitFor(1000);
    console.log("click arguments button");
    await inspector.evaluate(() => {
      document.querySelector("[data-test-arguments-button]")!["click"]();
    });
    // await inspector.click("[data-test-arguments-button]");
    await inspector.waitFor(1000);
    // console.log(await inspector.evaluate(() => document.body.innerHTML));
    await inspector.waitFor("[data-test-argument='URL'");
    console.log("clicking URL argument button");

    // await inspector.click("[data-test-argument='URL']");
    // console.log(await inspector.evaluate(() => document.body.innerHTML));

    console.log("try manual click");
    // console.log(await inspector.evaluate(() => document.body.innerHTML));
    await inspector.evaluate(() => {
      document.querySelector("[data-test-argument='URL']")!["click"]();
    });
    await waitForSelectedChar(inspector, "h"); // h in http://....
  }, 90000);

  async function waitForInPageInspector(page) {
    while (true) {
      const inspectorFrame = page
        .mainFrame()
        .childFrames()
        .find(frame => frame.url() && frame.url().includes(backendPort));
      if (inspectorFrame) {
        break;
      }
      await page.waitFor(100);
    }
    const childFrames = page.mainFrame().childFrames();
    const inspectorFrame = childFrames[0];
    return inspectorFrame;
  }

  it("Doesn't try to process initial page HTML too late if no script tags in body", async () => {
    // I had this problem because normally a script tag in the body triggers setting
    // initialPageHtml elOrigin

    const page = await createPage();
    await page.goto(
      "http://localhost:" + webServerPort + "/tests/bodyWithoutScriptTags/"
    );
    const testResult = await (await page.waitForFunction(
      'window["testResult"]'
    )).jsonValue();
    let pageSessionId = await page.evaluate(`global["fromJSPageSessionId"]`);

    const html = testResult.parts.map(p => p[0]).join("");

    let res = await inspectDomCharAndTraverse(
      pageSessionId,
      html.indexOf("setByInnerHTML")
    );
    expect(res.operationLog.operation).toBe("stringLiteral");
    expect(res.operationLog.result.primitive).toBe("setByInnerHTML");

    res = await inspectDomCharAndTraverse(
      pageSessionId,
      html.indexOf("realInitialPageHtml")
    );
    expect(res.operationLog.operation).toBe("initialPageHtml");
    expect(res.operationLog.result.primitive).toContain("realInitialPageHtml");

    const fullPageHtml = require("fs")
      .readFileSync(__dirname + "/tests/bodyWithoutScriptTags/index.html")
      .toString();
    expect(res.charIndex).toBe(fullPageHtml.indexOf("realInitialPageHtml"));
  }, 60000);

  it("Can traverse script tags and eval", async () => {
    // Load inspected page
    const page = await createPage();
    await page.goto(
      "http://localhost:" + webServerPort + "/tests/scriptTagAndEval/"
    );
    await page.waitForSelector("#abcd", { timeout: 60000 });

    await page.waitForSelector("#fromjs-inspect-dom-button");
    await page.click("#fromjs-inspect-dom-button");
    await page.waitForFunction(
      "document.querySelector('#fromjs-inspect-dom-button').innerText.includes('Click')"
    );
    await page.click("#abcd");

    const inspectorPage = await waitForInPageInspector(page);
    await inspectorPage.waitForFunction(() =>
      document.body.innerHTML.includes("InitialPageHtml")
    );
    await waitForSelectedChar(inspectorPage, "a");

    await page.click("#xyz");
    await inspectorPage.waitForFunction(() =>
      document.body.innerHTML.includes("InitialPageHtml")
    );

    await waitForSelectedChar(inspectorPage, "x");

    await page.click("#newFunction");
    await inspectorPage.waitForFunction(() =>
      document.body.innerHTML.includes("InitialPageHtml")
    );
    await waitForSelectedChar(inspectorPage, "n");
  }, 90000);
});
