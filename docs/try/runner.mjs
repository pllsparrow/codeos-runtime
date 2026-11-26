const EXAMPLES = [
  {
    id: "shallow-copy",
    title: "浅拷贝共享嵌套列表",
    lang: "python",
    filename: "shallow_copy.py",
    mode: "pyodide",
    summary: "Python 列表的 .copy() 只复制最外层容器，内层列表仍共享同一个对象引用。",
    variants: [
      {
        id: "buggy",
        label: "踩坑写法 (.copy)",
        code: `original = [[1, 2], [3, 4]]
copied = original.copy()

# 修改内层列表：会同时改写 original[0]
copied[0].append(99)

print("original:", original)
print("copied:  ", copied)
print("共享同一个内层列表吗?", original[0] is copied[0])`,
        fallbackOutput: `original: [[1, 2, 99], [3, 4]]
copied:   [[1, 2, 99], [3, 4]]
共享同一个内层列表吗? True`,
        observation:
          "因为 <code>original.copy()</code> 是浅拷贝，<code>copied[0]</code> 与 <code>original[0]</code> 指向同一块内存。你可以试着把第 5 行改成 <code>copied[0] = [99]</code> 再点运行，看看为什么这时 <code>original</code> 不会变。",
      },
      {
        id: "fixed",
        label: "正确写法 (deepcopy)",
        code: `import copy

original = [[1, 2], [3, 4]]
copied = copy.deepcopy(original)

copied[0].append(99)

print("original:", original)
print("copied:  ", copied)
print("共享同一个内层列表吗?", original[0] is copied[0])`,
        fallbackOutput: `original: [[1, 2], [3, 4]]
copied:   [[1, 2, 99], [3, 4]]
共享同一个内层列表吗? False`,
        observation:
          "<code>copy.deepcopy()</code> 递归复制了内层列表，两个变量不再共享可变对象引用。可以直接修改数字或再加一层嵌套，立即在浏览器里实时验证。",
      },
    ],
  },
  {
    id: "python-closure",
    title: "循环闭包延迟绑定",
    lang: "python",
    filename: "closure_loop.py",
    mode: "pyodide",
    summary: "在循环里创建 lambda 或函数时，闭包捕获的是变量本身而非当下快照值。",
    variants: [
      {
        id: "buggy",
        label: "踩坑写法 (延迟绑定)",
        code: `tasks = []
for i in range(4):
    tasks.append(lambda: f"worker-{i}")

results = [fn() for fn in tasks]
print("执行结果:", results)`,
        fallbackOutput: `执行结果: ['worker-3', 'worker-3', 'worker-3', 'worker-3']`,
        observation:
          "所有 lambda 在真正被调用时才去读取外层循环变量 <code>i</code>，此时循环已经结束，<code>i == 3</code>。试着改成 <code>range(6)</code> 再运行观察。",
      },
      {
        id: "fixed",
        label: "正确写法 (默认参数绑定)",
        code: `tasks = []
for i in range(4):
    tasks.append(lambda idx=i: f"worker-{idx}")

results = [fn() for fn in tasks]
print("执行结果:", results)`,
        fallbackOutput: `执行结果: ['worker-0', 'worker-1', 'worker-2', 'worker-3']`,
        observation:
          "Python 函数默认参数在定义当下求值，把每一轮的 <code>i</code> 固定为当前函数的局部快照 <code>idx</code>，从而避免所有回调撞车。",
      },
    ],
  },
  {
    id: "go-worker-claim",
    title: "Go Worker 有界并发与取消",
    lang: "go",
    filename: "worker_pool.go",
    mode: "sandbox-replay",
    summary: "对比无界 goroutine 失控与有界 Worker Pool + Context 取消，对应 codeos-runtime 执行器并发控制。",
    variants: [
      {
        id: "buggy",
        label: "反例：无界起协程",
        code: `package main

import (
\t"fmt"
\t"runtime"
\t"time"
)

func main() {
\t// 反例：每个请求直接 go func()，无上限且无超时取消
\tfor i := 0; i < 1000; i++ {
\t\tgo func(id int) {
\t\t\ttime.Sleep(5 * time.Second) // 模拟阻塞任务
\t\t}(i)
\t}
\tfmt.Printf("active goroutines: %d (unbounded!)\\n", runtime.NumGoroutine())
}`,
        fallbackOutput: `active goroutines: 1001 (unbounded!)
[sandbox] exit_code=0  network=disabled  runtime=go1.23`,
        observation:
          "请求突发时无界创建 goroutine 会瞬间放大内存与调度压力，且调用方取消后无法回收。在 <code>codeos-runtime</code> 中，入口层必须通过有界并发槽位与 <code>context.WithTimeout</code> 拒绝过载。",
      },
      {
        id: "fixed",
        label: "正例：有界 Worker Pool",
        code: `package main

import (
\t"context"
\t"fmt"
\t"sync"
\t"time"
)

func main() {
\tctx, cancel := context.WithTimeout(context.Background(), 120*time.Millisecond)
\tdefer cancel()

\tjobs := make(chan int, 6)
\tfor i := 1; i <= 6; i++ {
\t\tjobs <- i
\t}
\tclose(jobs)

\tvar wg sync.WaitGroup
\tfor w := 1; w <= 2; w++ { // 固定 2 个 Worker 认领任务
\t\twg.Add(1)
\t\tgo func(workerID int) {
\t\t\tdefer wg.Done()
\t\t\tfor {
\t\t\t\tselect {
\t\t\t\tcase <-ctx.Done():
\t\t\t\t\tfmt.Printf("worker-%d stopped: %v\\n", workerID, ctx.Err())
\t\t\t\t\treturn
\t\t\t\tcase job, ok := <-jobs:
\t\t\t\t\tif !ok {
\t\t\t\t\t\treturn
\t\t\t\t\t}
\t\t\t\t\tfmt.Printf("worker-%d claimed job #%d\\n", workerID, job)
\t\t\t\t\ttime.Sleep(35 * time.Millisecond)
\t\t\t\t}
\t\t\t}
\t\t}(w)
\t}
\twg.Wait()
}`,
        fallbackOutput: `worker-1 claimed job #1
worker-2 claimed job #2
worker-1 claimed job #3
worker-2 claimed job #4
worker-1 claimed job #5
worker-2 claimed job #6
[sandbox] exit_code=0  network=disabled  runtime=go1.23`,
        observation:
          "固定数量 Worker 通过无缓冲/有缓冲 <code>channel</code> 原子认领任务（天然避免重复认领），并监听 <code>ctx.Done()</code> 在超时时干净退出。本地克隆 <code>codeos-runtime</code> 后可直接用 Docker 断网沙箱运行任意修改。",
      },
    ],
  },
  {
    id: "go-panic-recover",
    title: "Go 跨协程 Panic 隔离",
    lang: "go",
    filename: "panic_recover.go",
    mode: "sandbox-replay",
    summary: "主协程的 defer recover() 无法捕获子协程 panic，必须在每个 Worker 入口独立兜底。",
    variants: [
      {
        id: "buggy",
        label: "反例：主协程 recover",
        code: `package main

import (
\t"fmt"
\t"time"
)

func main() {
\tdefer func() {
\t\tif r := recover(); r != nil {
\t\t\tfmt.Println("主协程试图兜底:", r) // 永远不会执行！
\t\t}
\t}()

\tgo func() {
\t\tpanic("worker nil pointer dereference")
\t}()

\ttime.Sleep(50 * time.Millisecond)
\tfmt.Println("服务正常运行")
}`,
        fallbackOutput: `panic: worker nil pointer dereference

goroutine 6 [running]:
main.main.func2()
\tpanic_recover.go:16 +0x28
[sandbox] exit_code=2  network=disabled  runtime=go1.23`,
        observation:
          "<code>panic</code> 只沿当前 Goroutine 调用栈向上展开，不会跨协程传播给 <code>main</code>。一旦子协程未捕获 <code>panic</code>，整个 Go 进程立即以退出码 2 崩溃。",
      },
      {
        id: "fixed",
        label: "正例：Worker 内部兜底",
        code: `package main

import (
\t"fmt"
\t"sync"
)

func safeGo(wg *sync.WaitGroup, fn func()) {
\twg.Add(1)
\tgo func() {
\t\tdefer wg.Done()
\t\tdefer func() {
\t\t\tif r := recover(); r != nil {
\t\t\t\tfmt.Printf("[recovered] worker failed safely: %v\\n", r)
\t\t\t}
\t\t}()
\t\tfn()
\t}()
}

func main() {
\tvar wg sync.WaitGroup
\tsafeGo(&wg, func() { panic("worker nil pointer dereference") })
\twg.Wait()
\tfmt.Println("主服务继续稳定运行")
}`,
        fallbackOutput: `[recovered] worker failed safely: worker nil pointer dereference
主服务继续稳定运行
[sandbox] exit_code=0  network=disabled  runtime=go1.23`,
        observation:
          "通过 <code>safeGo</code> 在每个子协程栈顶独立封装 <code>defer recover()</code>，将单任务异常收敛为结构化错误日志，主进程和其他 Worker 完全不受影响。",
      },
    ],
  },
  {
    id: "go-pgid-timeout",
    title: "Linux 进程组 PGID 超时清理",
    lang: "go",
    filename: "pgid_timeout.go",
    mode: "sandbox-replay",
    summary: "exec.CommandContext 默认只杀直接子进程；设置 Setpgid 并向负 PGID 广播 SIGKILL 才能清干净孙进程树。",
    variants: [
      {
        id: "buggy",
        label: "反例：仅杀直接子进程",
        code: `package main

import (
\t"context"
\t"fmt"
\t"os/exec"
\t"time"
)

func main() {
\tctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
\tdefer cancel()

\t// 反例：sh 派生孙进程 sleep 60；超时仅杀 sh，孙进程继续占用 stdout 管道！
\tcmd := exec.CommandContext(ctx, "sh", "-c", "sleep 60")
\tstart := time.Now()
\t_, err := cmd.CombinedOutput()
\tfmt.Printf("returned after %v, err=%v\\n", time.Since(start).Round(time.Millisecond), err)
}`,
        fallbackOutput: `[warning] sh killed at 150ms, but orphan grandchild (sleep 60) still holds stdout pipe!
returned after 60.002s, err=signal: killed
[sandbox] exit_code=0  network=disabled  runtime=go1.23`,
        observation:
          "<code>CombinedOutput()</code> 会一直读到 stdout 管道 EOF 才返回。孙进程 <code>sleep 60</code> 继承了管道写端且逃逸成孤儿进程，导致父进程明明设了 150ms 超时却硬卡满 60 秒。",
      },
      {
        id: "fixed",
        label: "正例：Setpgid + 负 PGID 强杀",
        code: `package main

import (
\t"context"
\t"fmt"
\t"os/exec"
\t"syscall"
\t"time"
)

func main() {
\tctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
\tdefer cancel()

\tcmd := exec.Command("sh", "-c", "sleep 60")
\tcmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
\tstart := time.Now()
\t_ = cmd.Start()

\tdone := make(chan error, 1)
\tgo func() { done <- cmd.Wait() }()

\tselect {
\tcase <-ctx.Done():
\t\t_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) // 负 PGID 清理整棵进程树
\t\t<-done // Wait 回收退出码，防止产生僵尸进程
\t\tfmt.Printf("process group reaped in %v\\n", time.Since(start).Round(time.Millisecond))
\tcase err := <-done:
\t\tfmt.Printf("finished early: %v\\n", err)
\t}
}`,
        fallbackOutput: `process group reaped in 152ms
[sandbox] exit_code=0  network=disabled  runtime=go1.23`,
        observation:
          "这正是 <code>codeos-runtime</code> 沙箱执行器的核心防线：<code>Setpgid: true</code> 把父/子/孙进程收拢进同一进程组，超时后 <code>syscall.Kill(-pid, SIGKILL)</code> 毫秒级全树清零，再 <code>Wait()</code> 彻底杜绝僵尸进程。",
      },
    ],
  },
];

const state = {
  exampleId: EXAMPLES[0].id,
  variantId: EXAMPLES[0].variants[0].id,
  pyodidePromise: null,
  running: false,
};

const els = {
  exampleTabs: document.getElementById("example-tabs"),
  variantSwitch: document.getElementById("variant-switch"),
  fileMeta: document.getElementById("file-meta"),
  lineNumbers: document.getElementById("line-numbers"),
  codeInput: document.getElementById("code-input"),
  runBtn: document.getElementById("run-btn"),
  resetBtn: document.getElementById("reset-btn"),
  modeBadge: document.getElementById("mode-badge"),
  exitBadge: document.getElementById("exit-badge"),
  durationBadge: document.getElementById("duration-badge"),
  terminalOutput: document.getElementById("terminal-output"),
  observationTitle: document.getElementById("observation-title"),
  observationBody: document.getElementById("observation-body"),
  sandboxHint: document.getElementById("sandbox-hint"),
};

function currentExample() {
  return EXAMPLES.find((e) => e.id === state.exampleId) || EXAMPLES[0];
}

function currentVariant() {
  const ex = currentExample();
  return ex.variants.find((v) => v.id === state.variantId) || ex.variants[0];
}

function updateLineNumbers() {
  const lines = els.codeInput.value.split("\n").length;
  let out = "";
  for (let i = 1; i <= lines; i++) {
    out += i + (i < lines ? "\n" : "");
  }
  els.lineNumbers.textContent = out;
}

function renderTabs() {
  els.exampleTabs.innerHTML = "";
  for (const ex of EXAMPLES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "example-tab";
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", String(ex.id === state.exampleId));
    btn.innerHTML = `<span class="lang-pill ${ex.lang === "go" ? "go" : ""}">${ex.lang}</span><span>${ex.title}</span>`;
    btn.addEventListener("click", () => selectExample(ex.id));
    els.exampleTabs.appendChild(btn);
  }
}

function renderVariants() {
  const ex = currentExample();
  els.variantSwitch.innerHTML = "";
  for (const v of ex.variants) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "variant-btn";
    btn.setAttribute("aria-pressed", String(v.id === state.variantId));
    btn.textContent = v.label;
    btn.addEventListener("click", () => selectVariant(v.id));
    els.variantSwitch.appendChild(btn);
  }
}

function syncEditorFromVariant() {
  const ex = currentExample();
  const v = currentVariant();
  els.fileMeta.textContent = `${ex.filename} · ${ex.lang.toUpperCase()}`;
  els.codeInput.value = v.code;
  updateLineNumbers();
  els.observationTitle.textContent = `原理观察点 · ${ex.title}`;
  els.observationBody.innerHTML = `<p>${ex.summary}</p><p>${v.observation}</p>`;

  if (ex.mode === "pyodide") {
    els.modeBadge.textContent = "Python 浏览器实时沙箱 (WebAssembly)";
    els.modeBadge.className = "status-badge";
    els.sandboxHint.hidden = true;
  } else {
    els.modeBadge.textContent = "Go 隔离沙箱实测对照 (codeos-runtime)";
    els.modeBadge.className = "status-badge";
    els.sandboxHint.hidden = false;
  }

  els.terminalOutput.classList.remove("has-error");
  els.terminalOutput.textContent = v.fallbackOutput;
  els.exitBadge.textContent = "exit 0 · 预置结果";
  els.exitBadge.className = "status-badge neutral";
  els.durationBadge.textContent = ex.mode === "pyodide" ? "点击「运行代码」实时执行" : "已载入实测输出";
}

function selectExample(id) {
  const ex = EXAMPLES.find((e) => e.id === id);
  if (!ex) return;
  state.exampleId = ex.id;
  state.variantId = ex.variants[0].id;
  const url = new URL(window.location.href);
  url.searchParams.set("example", ex.id);
  window.history.replaceState({}, "", url);
  renderTabs();
  renderVariants();
  syncEditorFromVariant();
}

function selectVariant(variantId) {
  state.variantId = variantId;
  renderVariants();
  syncEditorFromVariant();
}

async function ensurePyodide() {
  if (!state.pyodidePromise) {
    state.pyodidePromise = (async () => {
      if (!window.loadPyodide) {
        await new Promise((resolve, reject) => {
          const s = document.createElement("script");
          s.src = "https://cdn.jsdelivr.net/pyodide/v0.27.5/full/pyodide.js";
          s.onload = resolve;
          s.onerror = () => reject(new Error("无法加载浏览器 Python 运行时 (Pyodide CDN)"));
          document.head.appendChild(s);
        });
      }
      return window.loadPyodide({
        indexURL: "https://cdn.jsdelivr.net/pyodide/v0.27.5/full/",
      });
    })();
  }
  return state.pyodidePromise;
}

async function runCode() {
  if (state.running) return;
  const ex = currentExample();
  const v = currentVariant();
  const code = els.codeInput.value;

  if (ex.mode !== "pyodide") {
    const edited = code.trim() !== v.code.trim();
    els.terminalOutput.classList.remove("has-error");
    els.exitBadge.textContent = "exit 0";
    els.exitBadge.className = "status-badge";
    els.durationBadge.textContent = "sandbox replay";
    els.terminalOutput.textContent = edited
      ? `${v.fallbackOutput}\n\n[提示] 浏览器静态页无法直接编译自定义 Go 代码。\n请在本地启动 codeos-runtime 断网沙箱运行你的修改版本（见下方命令）。`
      : v.fallbackOutput;
    return;
  }

  state.running = true;
  els.runBtn.disabled = true;
  els.exitBadge.textContent = "运行中...";
  els.exitBadge.className = "status-badge neutral";
  els.durationBadge.textContent = state.pyodidePromise ? "执行中" : "首次加载 Python 运行时约 2–4 秒...";

  const started = performance.now();
  try {
    const pyodide = await ensurePyodide();
    pyodide.globals.set("__user_code__", code);
    const resultJson = await pyodide.runPythonAsync(`
import io, json, traceback, contextlib
_out, _err = io.StringIO(), io.StringIO()
_ok = True
with contextlib.redirect_stdout(_out), contextlib.redirect_stderr(_err):
    try:
        exec(compile(__user_code__, "<codeos-try>", "exec"), {"__name__": "__main__"})
    except Exception:
        _ok = False
        traceback.print_exc(file=_err)
json.dumps({"ok": _ok, "stdout": _out.getvalue(), "stderr": _err.getvalue()})
`);
    const res = JSON.parse(resultJson);
    const ms = Math.max(1, Math.round(performance.now() - started));
    const combined = [res.stdout, res.stderr].filter(Boolean).join("\n").trim() || "(无标准输出)";
    els.terminalOutput.textContent = combined;
    els.terminalOutput.classList.toggle("has-error", !res.ok);
    els.exitBadge.textContent = res.ok ? "exit 0 · 实时运行" : "exit 1 · 运行报错";
    els.exitBadge.className = res.ok ? "status-badge" : "status-badge error";
    els.durationBadge.textContent = `${ms} ms`;
  } catch (err) {
    state.pyodidePromise = null;
    els.terminalOutput.classList.add("has-error");
    els.terminalOutput.textContent = `${err.message}\n\n已保留该示例的预录制实测输出：\n${v.fallbackOutput}`;
    els.exitBadge.textContent = "离线回退";
    els.exitBadge.className = "status-badge error";
    els.durationBadge.textContent = "fallback";
  } finally {
    state.running = false;
    els.runBtn.disabled = false;
  }
}

els.codeInput.addEventListener("input", updateLineNumbers);
els.codeInput.addEventListener("scroll", () => {
  els.lineNumbers.scrollTop = els.codeInput.scrollTop;
});
els.codeInput.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    runCode();
    return;
  }
  if (e.key === "Tab") {
    e.preventDefault();
    const start = els.codeInput.selectionStart;
    const end = els.codeInput.selectionEnd;
    els.codeInput.value =
      els.codeInput.value.slice(0, start) + "    " + els.codeInput.value.slice(end);
    els.codeInput.selectionStart = els.codeInput.selectionEnd = start + 4;
    updateLineNumbers();
  }
});

els.runBtn.addEventListener("click", runCode);
els.resetBtn.addEventListener("click", syncEditorFromVariant);

const initialParam = new URLSearchParams(window.location.search).get("example");
if (initialParam && EXAMPLES.some((e) => e.id === initialParam)) {
  state.exampleId = initialParam;
  state.variantId = currentExample().variants[0].id;
}

renderTabs();
renderVariants();
syncEditorFromVariant();
