import {
  acceptCompletion,
  autocompletion,
  type Completion,
  CompletionContext,
  type CompletionResult,
  type CompletionSource,
  completionStatus,
  hasNextSnippetField,
  hasPrevSnippetField,
  nextSnippetField,
  prevSnippetField,
  snippetCompletion,
  startCompletion,
} from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import { EditorState, type Extension, Prec, StateField } from '@codemirror/state';
import { EditorView, keymap, showTooltip, type Tooltip } from '@codemirror/view';
import type { CompletionSymbolItem, ExternalModuleSymbols } from '@/types';

export interface IntelliSenseExternalContext {
  siblingModules: ExternalModuleSymbols[];
  runtimePythonModules: Record<string, CompletionSymbolItem[]>;
}

interface SignatureRecord {
  label: string;
  params: string;
  doc?: string;
  stripSelf?: boolean;
}

export type CandidateOrigin =
  | 'enclosing-param'
  | 'enclosing-local'
  | 'self-member'
  | 'imported-symbol'
  | 'file-var'
  | 'file-fn'
  | 'file-class'
  | 'sibling-module'
  | 'snippet'
  | 'stmt-keyword'
  | 'expr-keyword'
  | 'builtin-core'
  | 'builtin-rare'
  | 'member'
  | 'buffer-word';

export interface RankedCompletion extends Completion {
  _origin?: CandidateOrigin;
  _defLine?: number;
}

interface FunctionScopeInfo {
  name: string;
  startLine: number;
  endLine: number;
  indent: number;
  params: string[];
  localVars: Map<string, number>;
}

interface AnalyzedDocument {
  /** alias -> canonical module path, e.g. "np" -> "numpy", "F" -> "torch.nn.functional" */
  aliases: Map<string, string>;
  /** Top-level symbols defined or imported in current buffer */
  localCompletions: RankedCompletion[];
  /** Quick lookup for call-signature tooltips */
  localSignatures: Map<string, SignatureRecord>;
  /** Class name -> members (`self.xxx` attributes and methods) */
  classMembers: Map<
    string,
    {
      inheritsNnModule: boolean;
      completions: RankedCompletion[];
      signatures: Map<string, SignatureRecord>;
    }
  >;
  /** Active class name enclosing a 1-based line number */
  lineToClass: (lineNo: number) => string | null;
  /** Active function scope enclosing a 1-based line number */
  lineToFunction: (lineNo: number) => FunctionScopeInfo | null;
  /** All local/indented variable assignments across the file (name -> latest 1-based line) */
  scopedVarLines: Map<string, number>;
  /** Unique identifiers present in current buffer (name -> latest 1-based line) */
  identifierLines: Map<string, number>;
  /** Set view for compatibility */
  identifiers: Set<string>;
}

interface CatalogEntry {
  label: string;
  type: 'function' | 'class' | 'variable' | 'constant' | 'property' | 'keyword' | 'namespace' | 'method';
  detail?: string;
  doc?: string;
  boost?: number;
}

function toCompletion(
  entry: CatalogEntry,
  fallbackDetail?: string,
  origin: CandidateOrigin = 'member'
): RankedCompletion {
  return {
    label: entry.label,
    type: entry.type,
    detail: entry.detail || fallbackDetail,
    info: entry.doc || undefined,
    boost: entry.boost ?? 0,
    _origin: origin,
  };
}

function externalItemToCompletion(
  item: CompletionSymbolItem,
  sourceTag: string,
  boost = 10
): RankedCompletion {
  const mappedType =
    item.kind === 'function'
      ? 'function'
      : item.kind === 'class'
        ? 'class'
        : item.kind === 'module'
          ? 'namespace'
          : item.kind === 'constant'
            ? 'constant'
            : item.kind === 'property'
              ? 'property'
              : 'variable';
  return {
    label: item.label,
    type: mappedType,
    detail: item.detail ? `${item.detail}` : sourceTag,
    info: item.doc ?? undefined,
    boost,
    _origin: 'member',
  };
}

// ============================================================================
// 1. Curated Language Snippets, Built-ins & Scientific Python Catalogs
// ============================================================================

const PYTHON_SNIPPETS: Completion[] = [
  snippetCompletion('def ${1:func_name}(${2:args}):\n\t${0:pass}', {
    label: 'def',
    detail: '函数定义模板',
    type: 'keyword',
    info: '定义标准 Python 函数（按 Tab 键依次跳转参数与函数体）',
    boost: 35,
    section: '代码片段',
  }),
  snippetCompletion('async def ${1:func_name}(${2:args}):\n\t${0:pass}', {
    label: 'adef',
    detail: 'async def 异步函数',
    type: 'keyword',
    info: '定义异步协程函数',
    boost: 22,
    section: '代码片段',
  }),
  snippetCompletion(
    'class ${1:ClassName}:\n\tdef __init__(self, ${2:args}):\n\t\t${0:pass}',
    {
      label: 'class',
      detail: '类定义模板',
      type: 'keyword',
      info: '创建包含 __init__ 构造函数的 Python 类',
      boost: 32,
      section: '代码片段',
    }
  ),
  snippetCompletion('if __name__ == "__main__":\n\t${0:main()}', {
    label: 'ifmain',
    detail: 'if __name__ == "__main__":',
    type: 'keyword',
    info: 'Python 脚本主入口保护块',
    boost: 38,
    section: '代码片段',
  }),
  snippetCompletion('for ${1:item} in ${2:iterable}:\n\t${0:pass}', {
    label: 'for',
    detail: 'for 循环模板',
    type: 'keyword',
    boost: 28,
    section: '代码片段',
  }),
  snippetCompletion('for ${1:idx}, ${2:item} in enumerate(${3:iterable}):\n\t${0:pass}', {
    label: 'fore',
    detail: 'for i, x in enumerate(...)',
    type: 'keyword',
    info: '带索引枚举遍历序列',
    boost: 30,
    section: '代码片段',
  }),
  snippetCompletion(
    'with open(${1:"data.txt"}, "${2:r}", encoding="utf-8") as ${3:f}:\n\t${0:content = f.read()}',
    {
      label: 'withopen',
      detail: 'with open(..., utf-8) as f:',
      type: 'keyword',
      info: 'UTF-8 安全读写本地文件上下文',
      boost: 28,
      section: '代码片段',
    }
  ),
  snippetCompletion('try:\n\t${1:pass}\nexcept ${2:Exception} as ${3:err}:\n\t${0:print(err)}', {
    label: 'try',
    detail: 'try ... except 异常捕获',
    type: 'keyword',
    boost: 26,
    section: '代码片段',
  }),
  snippetCompletion(
    'class ${1:Model}(nn.Module):\n\tdef __init__(self, ${2:in_dim: int = 64, out_dim: int = 1}):\n\t\tsuper().__init__()\n\t\tself.net = nn.Sequential(\n\t\t\tnn.Linear(${3:in_dim}, 128),\n\t\t\tnn.GELU(),\n\t\t\tnn.Linear(128, ${4:out_dim}),\n\t\t)\n\n\tdef forward(self, x: torch.Tensor) -> torch.Tensor:\n\t\treturn ${0:self.net(x)}',
    {
      label: 'nnmod',
      detail: 'PyTorch nn.Module 网络模板',
      type: 'class',
      info: '快速生成带 __init__ 与 forward 的 PyTorch 神经网络模块',
      boost: 30,
      section: '代码片段',
    }
  ),
];

const PYTHON_KEYWORDS = [
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'case',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'False',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'match',
  'None',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'True',
  'try',
  'while',
  'with',
  'yield',
];

const PYTHON_BUILTINS: CatalogEntry[] = [
  { label: 'print', type: 'function', detail: '(*values, sep=" ", end="\\n", flush=False)', doc: '打印输出到控制台', boost: 30 },
  { label: 'len', type: 'function', detail: '(obj) -> int', doc: '返回序列或集合的元素个数', boost: 28 },
  { label: 'range', type: 'function', detail: '(start, stop[, step])', doc: '生成等差整数序列迭代器', boost: 28 },
  { label: 'enumerate', type: 'function', detail: '(iterable, start=0)', doc: '同时返回元素下标 (index, value)', boost: 28 },
  { label: 'zip', type: 'function', detail: '(*iterables, strict=False)', doc: '并行聚合多个可迭代对象', boost: 24 },
  { label: 'sorted', type: 'function', detail: '(iterable, *, key=None, reverse=False)', doc: '返回排序后的新列表', boost: 24 },
  { label: 'reversed', type: 'function', detail: '(seq)', doc: '返回反向迭代器', boost: 18 },
  { label: 'map', type: 'function', detail: '(func, *iterables)', doc: '对可迭代对象逐元素映射函数', boost: 20 },
  { label: 'filter', type: 'function', detail: '(func, iterable)', doc: '筛选满足条件的元素', boost: 20 },
  { label: 'sum', type: 'function', detail: '(iterable, start=0)', doc: '对数值序列求和', boost: 24 },
  { label: 'min', type: 'function', detail: '(iterable, *, key=None, default=...)', doc: '返回最小值', boost: 24 },
  { label: 'max', type: 'function', detail: '(iterable, *, key=None, default=...)', doc: '返回最大值', boost: 24 },
  { label: 'abs', type: 'function', detail: '(x)', doc: '返回绝对值或复数模', boost: 22 },
  { label: 'round', type: 'function', detail: '(number, ndigits=None)', doc: '四舍五入到指定小数位', boost: 22 },
  { label: 'pow', type: 'function', detail: '(base, exp, mod=None)', doc: '计算幂次 base ** exp', boost: 18 },
  { label: 'isinstance', type: 'function', detail: '(obj, class_or_tuple) -> bool', doc: '检查对象是否为指定类型实例', boost: 25 },
  { label: 'issubclass', type: 'function', detail: '(cls, class_or_tuple) -> bool', doc: '检查类是否为指定基类的子类', boost: 16 },
  { label: 'getattr', type: 'function', detail: '(obj, name[, default])', doc: '动态读取对象属性', boost: 20 },
  { label: 'setattr', type: 'function', detail: '(obj, name, value)', doc: '动态设置对象属性', boost: 18 },
  { label: 'hasattr', type: 'function', detail: '(obj, name) -> bool', doc: '检查对象是否拥有指定属性', boost: 20 },
  { label: 'open', type: 'function', detail: '(file, mode="r", encoding="utf-8")', doc: '打开本地文件并返回流对象', boost: 26 },
  { label: 'super', type: 'function', detail: '()', doc: '调用父类方法（如 super().__init__()）', boost: 24 },
  { label: 'dict', type: 'class', detail: '(**kwargs)', doc: '构造字典映射对象', boost: 22 },
  { label: 'list', type: 'class', detail: '(iterable=())', doc: '构造可变列表', boost: 22 },
  { label: 'set', type: 'class', detail: '(iterable=())', doc: '构造不重复集合', boost: 20 },
  { label: 'tuple', type: 'class', detail: '(iterable=())', doc: '构造不可变元组', boost: 20 },
  { label: 'str', type: 'class', detail: '(obj="")', doc: '转换为字符串', boost: 22 },
  { label: 'int', type: 'class', detail: '(x=0, base=10)', doc: '转换为整数', boost: 22 },
  { label: 'float', type: 'class', detail: '(x=0.0)', doc: '转换为浮点数', boost: 22 },
  { label: 'bool', type: 'class', detail: '(x=False)', doc: '转换为布尔值', boost: 20 },
  { label: 'any', type: 'function', detail: '(iterable) -> bool', doc: '任一元素为真即返回 True', boost: 20 },
  { label: 'all', type: 'function', detail: '(iterable) -> bool', doc: '所有元素均为真时返回 True', boost: 20 },
  { label: 'next', type: 'function', detail: '(iterator[, default])', doc: '获取迭代器的下一个元素', boost: 18 },
  { label: 'iter', type: 'function', detail: '(obj)', doc: '获取对象的迭代器', boost: 16 },
  { label: 'ValueError', type: 'class', detail: '(message)', doc: '参数值不合法异常', boost: 18 },
  { label: 'TypeError', type: 'class', detail: '(message)', doc: '类型不匹配异常', boost: 18 },
  { label: 'KeyError', type: 'class', detail: '(key)', doc: '字典键不存在异常', boost: 16 },
  { label: 'FileNotFoundError', type: 'class', detail: '(filename)', doc: '文件或目录不存在异常', boost: 18 },
  { label: 'RuntimeError', type: 'class', detail: '(message)', doc: '运行时异常', boost: 18 },
  { label: 'Exception', type: 'class', detail: '(message)', doc: '常规异常基类', boost: 20 },
];

const PYTHON_COMMON_MODULES: CatalogEntry[] = [
  { label: 'numpy', type: 'namespace', detail: '科学计算与多维数组库 (常简写 as np)', boost: 30 },
  { label: 'torch', type: 'namespace', detail: 'PyTorch 深度学习与张量计算框架', boost: 30 },
  { label: 'torch.nn', type: 'namespace', detail: 'PyTorch 神经网络层模块 (as nn)', boost: 28 },
  { label: 'torch.nn.functional', type: 'namespace', detail: 'PyTorch 无状态算子函数库 (as F)', boost: 28 },
  { label: 'torch.optim', type: 'namespace', detail: 'PyTorch 优化器模块', boost: 24 },
  { label: 'matplotlib.pyplot', type: 'namespace', detail: 'Matplotlib 绘图接口 (as plt)', boost: 28 },
  { label: 'pandas', type: 'namespace', detail: '表格与序列数据分析库 (as pd)', boost: 26 },
  { label: 'pathlib', type: 'namespace', detail: '面向对象跨平台路径库 (Path)', boost: 26 },
  { label: 'os', type: 'namespace', detail: '操作系统目录与环境变量接口', boost: 26 },
  { label: 'sys', type: 'namespace', detail: 'Python 解释器参数与路径控制', boost: 25 },
  { label: 'json', type: 'namespace', detail: 'JSON 编码与解析标准库', boost: 26 },
  { label: 'math', type: 'namespace', detail: '初等数学函数与常数标准库', boost: 25 },
  { label: 're', type: 'namespace', detail: '正则表达式匹配与替换库', boost: 22 },
  { label: 'time', type: 'namespace', detail: '高精度计时与时间戳标准库', boost: 22 },
  { label: 'typing', type: 'namespace', detail: 'Python 静态类型注解标准库', boost: 22 },
  { label: 'dataclasses', type: 'namespace', detail: '@dataclass 数据类装饰器标准库', boost: 20 },
  { label: 'collections', type: 'namespace', detail: 'defaultdict / Counter / deque 容器库', boost: 20 },
  { label: 'itertools', type: 'namespace', detail: '高效组合与迭代器工具库', boost: 18 },
  { label: 'functools', type: 'namespace', detail: 'lru_cache / partial 高阶函数库', boost: 18 },
  { label: 'argparse', type: 'namespace', detail: '命令行参数解析标准库', boost: 18 },
  { label: 'csv', type: 'namespace', detail: 'CSV 表格文件读写标准库', boost: 18 },
  { label: 'subprocess', type: 'namespace', detail: '外部子进程调用标准库', boost: 18 },
];

const PYTHON_MODULE_CATALOG: Record<string, CatalogEntry[]> = {
  numpy: [
    { label: 'array', type: 'function', detail: '(object, dtype=None)', doc: '创建 NumPy ndarray 多维数组', boost: 35 },
    { label: 'zeros', type: 'function', detail: '(shape, dtype=float)', doc: '创建全 0 数组', boost: 34 },
    { label: 'ones', type: 'function', detail: '(shape, dtype=float)', doc: '创建全 1 数组', boost: 32 },
    { label: 'full', type: 'function', detail: '(shape, fill_value, dtype=None)', doc: '创建指定常数填充的数组', boost: 26 },
    { label: 'empty', type: 'function', detail: '(shape, dtype=float)', doc: '分配未初始化数组内存', boost: 22 },
    { label: 'arange', type: 'function', detail: '([start,] stop[, step], dtype=None)', doc: '按步长生成等差数组', boost: 33 },
    { label: 'linspace', type: 'function', detail: '(start, stop, num=50, endpoint=True)', doc: '在区间内均匀采样指定数量网格点', boost: 35 },
    { label: 'meshgrid', type: 'function', detail: '(*xi, indexing="xy")', doc: '由一维坐标向量生成多维坐标网格', boost: 30 },
    { label: 'eye', type: 'function', detail: '(N, M=None, k=0, dtype=float)', doc: '生成二维单位矩阵', boost: 24 },
    { label: 'zeros_like', type: 'function', detail: '(a, dtype=None)', doc: '生成与输入同形状的全 0 数组', boost: 28 },
    { label: 'ones_like', type: 'function', detail: '(a, dtype=None)', doc: '生成与输入同形状的全 1 数组', boost: 26 },
    { label: 'concatenate', type: 'function', detail: '((a1, a2, ...), axis=0)', doc: '沿已有维度拼接多个数组', boost: 30 },
    { label: 'stack', type: 'function', detail: '(arrays, axis=0)', doc: '沿新维度堆叠数组序列', boost: 30 },
    { label: 'vstack', type: 'function', detail: '(tup)', doc: '按行垂直堆叠数组', boost: 24 },
    { label: 'hstack', type: 'function', detail: '(tup)', doc: '按列水平拼接数组', boost: 24 },
    { label: 'reshape', type: 'function', detail: '(a, newshape)', doc: '重塑数组维度形状', boost: 30 },
    { label: 'transpose', type: 'function', detail: '(a, axes=None)', doc: '转置或重排数组轴顺序', boost: 25 },
    { label: 'where', type: 'function', detail: '(condition[, x, y])', doc: '按条件掩码选择元素或返回满足条件索引', boost: 32 },
    { label: 'clip', type: 'function', detail: '(a, a_min, a_max)', doc: '将数组数值截断限制在 [a_min, a_max] 范围内', boost: 28 },
    { label: 'mean', type: 'function', detail: '(a, axis=None, keepdims=False)', doc: '计算算术平均值', boost: 32 },
    { label: 'std', type: 'function', detail: '(a, axis=None, ddof=0, keepdims=False)', doc: '计算标准差', boost: 30 },
    { label: 'var', type: 'function', detail: '(a, axis=None, keepdims=False)', doc: '计算方差', boost: 24 },
    { label: 'median', type: 'function', detail: '(a, axis=None)', doc: '计算中位数', boost: 24 },
    { label: 'percentile', type: 'function', detail: '(a, q, axis=None)', doc: '计算 q 分位数 (0~100)', boost: 24 },
    { label: 'sum', type: 'function', detail: '(a, axis=None, keepdims=False)', doc: '沿指定轴求和', boost: 30 },
    { label: 'min', type: 'function', detail: '(a, axis=None, keepdims=False)', doc: '沿指定轴求最小值', boost: 28 },
    { label: 'max', type: 'function', detail: '(a, axis=None, keepdims=False)', doc: '沿指定轴求最大值', boost: 28 },
    { label: 'argmin', type: 'function', detail: '(a, axis=None)', doc: '返回最小值所在下标', boost: 26 },
    { label: 'argmax', type: 'function', detail: '(a, axis=None)', doc: '返回最大值所在下标', boost: 26 },
    { label: 'argsort', type: 'function', detail: '(a, axis=-1)', doc: '返回从小到大排序后的元素索引', boost: 26 },
    { label: 'matmul', type: 'function', detail: '(x1, x2)', doc: '矩阵乘法', boost: 26 },
    { label: 'dot', type: 'function', detail: '(a, b)', doc: '向量内积或矩阵乘法', boost: 26 },
    { label: 'einsum', type: 'function', detail: '(subscripts, *operands)', doc: '爱因斯坦求和约定张量收缩', boost: 26 },
    { label: 'sin', type: 'function', detail: '(x)', doc: '逐元素正弦函数', boost: 26 },
    { label: 'cos', type: 'function', detail: '(x)', doc: '逐元素余弦函数', boost: 26 },
    { label: 'exp', type: 'function', detail: '(x)', doc: '逐元素自然指数 e^x', boost: 26 },
    { label: 'log', type: 'function', detail: '(x)', doc: '逐元素自然对数 ln(x)', boost: 24 },
    { label: 'sqrt', type: 'function', detail: '(x)', doc: '逐元素平方根', boost: 26 },
    { label: 'abs', type: 'function', detail: '(x)', doc: '逐元素绝对值', boost: 26 },
    { label: 'isfinite', type: 'function', detail: '(x) -> ndarray[bool]', doc: '逐元素检查是否为有限数值（非 NaN / Inf）', boost: 28 },
    { label: 'isnan', type: 'function', detail: '(x) -> ndarray[bool]', doc: '逐元素检查是否为 NaN', boost: 28 },
    { label: 'allclose', type: 'function', detail: '(a, b, rtol=1e-5, atol=1e-8) -> bool', doc: '在容差范围内比较两个数组是否近似相等', boost: 26 },
    { label: 'load', type: 'function', detail: '(file, allow_pickle=False)', doc: '读取 .npy 或 .npz 数据文件', boost: 30 },
    { label: 'save', type: 'function', detail: '(file, arr)', doc: '保存数组到 .npy 二进制文件', boost: 28 },
    { label: 'savez', type: 'function', detail: '(file, *args, **kwds)', doc: '保存多个命名数组到 .npz 文件', boost: 26 },
    { label: 'loadtxt', type: 'function', detail: '(fname, delimiter=None, skiprows=0)', doc: '从文本文件加载数值矩阵', boost: 24 },
    { label: 'linalg', type: 'namespace', detail: '线性代数子模块 (norm / solve / svd / inv)', boost: 26 },
    { label: 'fft', type: 'namespace', detail: '快速傅里叶变换子模块 (fft / rfft / fft2)', boost: 26 },
    { label: 'random', type: 'namespace', detail: '随机数采样模块 (default_rng / randn / seed)', boost: 28 },
    { label: 'float32', type: 'constant', detail: 'dtype float32', boost: 28 },
    { label: 'float64', type: 'constant', detail: 'dtype float64', boost: 26 },
    { label: 'int64', type: 'constant', detail: 'dtype int64', boost: 24 },
    { label: 'pi', type: 'constant', detail: '3.141592653589793', boost: 28 },
    { label: 'inf', type: 'constant', detail: '正无穷大 float("inf")', boost: 20 },
    { label: 'nan', type: 'constant', detail: '非数值 float("nan")', boost: 20 },
  ],
  torch: [
    { label: 'tensor', type: 'function', detail: '(data, *, dtype=None, device=None, requires_grad=False)', doc: '从列表或数组构造张量', boost: 36 },
    { label: 'zeros', type: 'function', detail: '(*size, dtype=None, device=None)', doc: '创建全 0 张量', boost: 34 },
    { label: 'ones', type: 'function', detail: '(*size, dtype=None, device=None)', doc: '创建全 1 张量', boost: 32 },
    { label: 'randn', type: 'function', detail: '(*size, dtype=None, device=None)', doc: '采样标准正态分布 N(0,1) 张量', boost: 34 },
    { label: 'rand', type: 'function', detail: '(*size, dtype=None, device=None)', doc: '采样区间 [0, 1) 均匀分布张量', boost: 32 },
    { label: 'linspace', type: 'function', detail: '(start, end, steps, *, dtype=None, device=None)', doc: '创建一维等距网格张量', boost: 32 },
    { label: 'arange', type: 'function', detail: '(start=0, end, step=1, *, device=None)', doc: '创建等差整数/浮点序列张量', boost: 30 },
    { label: 'from_numpy', type: 'function', detail: '(ndarray) -> Tensor', doc: '将 NumPy 数组零拷贝转换为 PyTorch 张量', boost: 32 },
    { label: 'as_tensor', type: 'function', detail: '(data, dtype=None, device=None)', doc: '零拷贝优先转换数据为 Tensor', boost: 28 },
    { label: 'cat', type: 'function', detail: '(tensors, dim=0)', doc: '沿已有维度拼接张量序列', boost: 34 },
    { label: 'stack', type: 'function', detail: '(tensors, dim=0)', doc: '沿新维度堆叠张量序列', boost: 32 },
    { label: 'unsqueeze', type: 'function', detail: '(input, dim)', doc: '在指定位置插入长度为 1 的维度', boost: 28 },
    { label: 'squeeze', type: 'function', detail: '(input, dim=None)', doc: '压缩长度为 1 的维度', boost: 28 },
    { label: 'einsum', type: 'function', detail: '(equation, *operands) -> Tensor', doc: '爱因斯坦求和约定算子（FNO 谱卷积常用）', boost: 32 },
    { label: 'matmul', type: 'function', detail: '(input, other) -> Tensor', doc: '批量或高维张量矩阵乘法', boost: 28 },
    { label: 'where', type: 'function', detail: '(condition, input, other)', doc: '按布尔掩码逐元素选择张量值', boost: 28 },
    { label: 'clamp', type: 'function', detail: '(input, min=None, max=None)', doc: '将张量元素限制在上下界内', boost: 26 },
    { label: 'mean', type: 'function', detail: '(input, dim=None, keepdim=False)', doc: '计算张量均值', boost: 30 },
    { label: 'std', type: 'function', detail: '(input, dim=None, keepdim=False)', doc: '计算张量标准差', boost: 26 },
    { label: 'sum', type: 'function', detail: '(input, dim=None, keepdim=False)', doc: '计算张量元素总和', boost: 30 },
    { label: 'no_grad', type: 'function', detail: '()', doc: '禁用梯度跟踪上下文管理器（推理/验证阶段必用）', boost: 35 },
    { label: 'inference_mode', type: 'function', detail: '(mode=True)', doc: '高性能推理模式上下文管理器', boost: 28 },
    { label: 'save', type: 'function', detail: '(obj, f)', doc: '序列化保存模型权重或字典到磁盘 (.pt/.pth)', boost: 30 },
    { label: 'load', type: 'function', detail: '(f, map_location=None, weights_only=True)', doc: '加载磁盘上的模型检查点文件', boost: 30 },
    { label: 'device', type: 'class', detail: '("cuda" | "cpu")', doc: '构造计算设备标识对象', boost: 32 },
    { label: 'Tensor', type: 'class', detail: 'torch.Tensor 类型注解', boost: 32 },
    { label: 'nn', type: 'namespace', detail: '神经网络模块库 torch.nn', boost: 34 },
    { label: 'optim', type: 'namespace', detail: '优化器模块库 torch.optim', boost: 30 },
    { label: 'fft', type: 'namespace', detail: '快速傅里叶变换模块 torch.fft', boost: 30 },
    { label: 'cuda', type: 'namespace', detail: 'CUDA GPU 控制模块 (is_available / empty_cache)', boost: 30 },
    { label: 'float32', type: 'constant', detail: 'torch.float32', boost: 30 },
    { label: 'float64', type: 'constant', detail: 'torch.float64', boost: 24 },
    { label: 'float16', type: 'constant', detail: 'torch.float16', boost: 24 },
    { label: 'long', type: 'constant', detail: 'torch.int64 索引类型', boost: 24 },
  ],
  'torch.nn': [
    { label: 'Module', type: 'class', detail: '神经网络模型基类', doc: '所有自定义 PyTorch 层与模型的基类', boost: 38 },
    { label: 'Sequential', type: 'class', detail: '(*layers)', doc: '按顺序串联多个子模块的容器', boost: 35 },
    { label: 'ModuleList', type: 'class', detail: '(modules=None)', doc: '可自动注册参数的模块列表容器', boost: 30 },
    { label: 'Parameter', type: 'class', detail: '(data, requires_grad=True)', doc: '可训练模型参数包装器', boost: 32 },
    { label: 'Linear', type: 'class', detail: '(in_features, out_features, bias=True)', doc: '全连接线性变换层 y = xA^T + b', boost: 36 },
    { label: 'Conv1d', type: 'class', detail: '(in_channels, out_channels, kernel_size, stride=1, padding=0)', doc: '一维卷积层', boost: 32 },
    { label: 'Conv2d', type: 'class', detail: '(in_channels, out_channels, kernel_size, stride=1, padding=0)', doc: '二维空间卷积层', boost: 35 },
    { label: 'Conv3d', type: 'class', detail: '(in_channels, out_channels, kernel_size, stride=1, padding=0)', doc: '三维卷积层', boost: 26 },
    { label: 'BatchNorm2d', type: 'class', detail: '(num_features)', doc: '二维批归一化层', boost: 28 },
    { label: 'LayerNorm', type: 'class', detail: '(normalized_shape, eps=1e-5)', doc: '层归一化 LayerNorm', boost: 32 },
    { label: 'GroupNorm', type: 'class', detail: '(num_groups, num_channels)', doc: '组归一化 GroupNorm（小 batch 物理场建模常用）', boost: 28 },
    { label: 'GELU', type: 'class', detail: '()', doc: '高斯误差线性单元激活层（神经算子/Transformer 常用）', boost: 34 },
    { label: 'ReLU', type: 'class', detail: '(inplace=False)', doc: '修正线性单元激活层', boost: 32 },
    { label: 'SiLU', type: 'class', detail: '(inplace=False)', doc: 'Swish / SiLU 平滑激活层', boost: 30 },
    { label: 'Tanh', type: 'class', detail: '()', doc: '双曲正切激活层（PINN 常用）', boost: 28 },
    { label: 'Dropout', type: 'class', detail: '(p=0.5)', doc: '随机失活正则化层', boost: 28 },
    { label: 'MultiheadAttention', type: 'class', detail: '(embed_dim, num_heads, dropout=0.0, batch_first=True)', doc: '多头注意力层', boost: 28 },
    { label: 'MSELoss', type: 'class', detail: '(reduction="mean")', doc: '均方误差损失函数', boost: 34 },
    { label: 'L1Loss', type: 'class', detail: '(reduction="mean")', doc: '平均绝对误差损失函数', boost: 30 },
    { label: 'HuberLoss', type: 'class', detail: '(reduction="mean", delta=1.0)', doc: '鲁棒 Huber 损失函数', boost: 28 },
    { label: 'CrossEntropyLoss', type: 'class', detail: '(weight=None, reduction="mean")', doc: '多分类交叉熵损失函数', boost: 30 },
    { label: 'Identity', type: 'class', detail: '()', doc: '恒等映射占位层', boost: 24 },
    { label: 'functional', type: 'namespace', detail: 'torch.nn.functional 无状态函数库', boost: 30 },
  ],
  'torch.nn.functional': [
    { label: 'mse_loss', type: 'function', detail: '(input, target, reduction="mean")', doc: '计算均方误差 MSE', boost: 36 },
    { label: 'l1_loss', type: 'function', detail: '(input, target, reduction="mean")', doc: '计算平均绝对误差 MAE', boost: 32 },
    { label: 'smooth_l1_loss', type: 'function', detail: '(input, target, beta=1.0)', doc: '计算平滑 L1 损失', boost: 28 },
    { label: 'huber_loss', type: 'function', detail: '(input, target, delta=1.0)', doc: '计算鲁棒 Huber 损失', boost: 28 },
    { label: 'cross_entropy', type: 'function', detail: '(input, target, reduction="mean")', doc: '计算交叉熵损失', boost: 30 },
    { label: 'gelu', type: 'function', detail: '(input)', doc: 'GELU 平滑激活函数', boost: 34 },
    { label: 'relu', type: 'function', detail: '(input, inplace=False)', doc: 'ReLU 激活函数', boost: 32 },
    { label: 'silu', type: 'function', detail: '(input, inplace=False)', doc: 'SiLU / Swish 激活函数', boost: 30 },
    { label: 'softmax', type: 'function', detail: '(input, dim=-1)', doc: '沿指定维度归一化概率分布', boost: 30 },
    { label: 'interpolate', type: 'function', detail: '(input, size=None, scale_factor=None, mode="bilinear", align_corners=False)', doc: '物理网格/特征图上下采样插值', boost: 34 },
    { label: 'pad', type: 'function', detail: '(input, pad, mode="constant", value=0)', doc: '对张量边缘进行填充（非周期边界 FNO 常用）', boost: 32 },
    { label: 'grid_sample', type: 'function', detail: '(input, grid, mode="bilinear", align_corners=True)', doc: '在任意连续坐标点对网格场双线性插值采样', boost: 28 },
    { label: 'conv2d', type: 'function', detail: '(input, weight, bias=None, stride=1, padding=0)', doc: '二维卷积函数调用', boost: 26 },
    { label: 'linear', type: 'function', detail: '(input, weight, bias=None)', doc: '线性层函数调用', boost: 26 },
  ],
  'torch.optim': [
    { label: 'AdamW', type: 'class', detail: '(params, lr=1e-3, weight_decay=1e-2)', doc: '解耦权重衰减的 AdamW 优化器（训练首选）', boost: 36 },
    { label: 'Adam', type: 'class', detail: '(params, lr=1e-3, betas=(0.9, 0.999))', doc: 'Adam 自适应矩估计优化器', boost: 34 },
    { label: 'SGD', type: 'class', detail: '(params, lr=1e-2, momentum=0.9)', doc: '随机梯度下降优化器', boost: 28 },
    { label: 'LBFGS', type: 'class', detail: '(params, lr=1.0, max_iter=20)', doc: '拟牛顿二阶优化器（物理场精细收敛常用）', boost: 26 },
    { label: 'lr_scheduler', type: 'namespace', detail: '学习率调度器子模块 (CosineAnnealingLR / ReduceLROnPlateau)', boost: 32 },
  ],
  'torch.fft': [
    { label: 'rfft', type: 'function', detail: '(input, n=None, dim=-1, norm=None)', doc: '一维实数快速傅里叶正变换', boost: 34 },
    { label: 'irfft', type: 'function', detail: '(input, n=None, dim=-1, norm=None)', doc: '一维实数快速傅里叶逆变换', boost: 34 },
    { label: 'rfft2', type: 'function', detail: '(input, s=None, dim=(-2, -1), norm=None)', doc: '二维实数傅里叶正变换（2D FNO 核心算子）', boost: 36 },
    { label: 'irfft2', type: 'function', detail: '(input, s=None, dim=(-2, -1), norm=None)', doc: '二维实数傅里叶逆变换（2D FNO 核心算子）', boost: 36 },
    { label: 'fft', type: 'function', detail: '(input, n=None, dim=-1)', doc: '一维复数傅里叶正变换', boost: 28 },
    { label: 'ifft', type: 'function', detail: '(input, n=None, dim=-1)', doc: '一维复数傅里叶逆变换', boost: 28 },
    { label: 'fftfreq', type: 'function', detail: '(n, d=1.0)', doc: '计算离散傅里叶采样频率坐标', boost: 26 },
    { label: 'rfftfreq', type: 'function', detail: '(n, d=1.0)', doc: '计算实数傅里叶非负频率坐标', boost: 26 },
  ],
  'matplotlib.pyplot': [
    { label: 'figure', type: 'function', detail: '(figsize=(8, 5), dpi=120)', doc: '新建绘图画布', boost: 34 },
    { label: 'subplots', type: 'function', detail: '(nrows=1, ncols=1, figsize=None, constrained_layout=True)', doc: '创建多子图网格 (fig, axes)', boost: 36 },
    { label: 'plot', type: 'function', detail: '(x, y, label=None, linewidth=2)', doc: '绘制折线曲线图', boost: 36 },
    { label: 'scatter', type: 'function', detail: '(x, y, c=None, s=20, cmap="viridis")', doc: '绘制散点图', boost: 32 },
    { label: 'imshow', type: 'function', detail: '(X, cmap="inferno", aspect="auto", origin="lower")', doc: '可视化二维矩阵/温度场热力图', boost: 35 },
    { label: 'contourf', type: 'function', detail: '(X, Y, Z, levels=32, cmap="turbo")', doc: '绘制填充等值线云图（流场/温度场常用）', boost: 34 },
    { label: 'pcolormesh', type: 'function', detail: '(X, Y, C, shading="auto", cmap="viridis")', doc: '绘制非均匀网格伪彩热力图', boost: 30 },
    { label: 'colorbar', type: 'function', detail: '(mappable=None, ax=None, label="")', doc: '添加色标刻度条', boost: 32 },
    { label: 'xlabel', type: 'function', detail: '(xlabel)', doc: '设置横轴标题', boost: 30 },
    { label: 'ylabel', type: 'function', detail: '(ylabel)', doc: '设置纵轴标题', boost: 30 },
    { label: 'title', type: 'function', detail: '(label)', doc: '设置图表标题', boost: 32 },
    { label: 'legend', type: 'function', detail: '(loc="best")', doc: '显示图例说明', boost: 30 },
    { label: 'grid', type: 'function', detail: '(visible=True, alpha=0.3)', doc: '显示辅助坐标网格线', boost: 28 },
    { label: 'tight_layout', type: 'function', detail: '()', doc: '自动紧凑调整子图边距', boost: 30 },
    { label: 'savefig', type: 'function', detail: '(fname, dpi=200, bbox_inches="tight")', doc: '导出高分辨率图片到磁盘', boost: 34 },
    { label: 'show', type: 'function', detail: '()', doc: '弹出窗口显示图像', boost: 32 },
    { label: 'close', type: 'function', detail: '(fig=None)', doc: '关闭画布释放内存', boost: 28 },
  ],
  pandas: [
    { label: 'DataFrame', type: 'class', detail: '(data=None, columns=None)', doc: '二维带标签表格数据结构', boost: 36 },
    { label: 'Series', type: 'class', detail: '(data=None, index=None)', doc: '一维带索引数据序列', boost: 30 },
    { label: 'read_csv', type: 'function', detail: '(filepath_or_buffer, encoding="utf-8")', doc: '读取 CSV 数据文件为 DataFrame', boost: 36 },
    { label: 'read_excel', type: 'function', detail: '(io, sheet_name=0)', doc: '读取 Excel 工作表', boost: 32 },
    { label: 'read_parquet', type: 'function', detail: '(path)', doc: '读取高性能 Parquet 列式数据', boost: 28 },
    { label: 'concat', type: 'function', detail: '(objs, axis=0, ignore_index=False)', doc: '拼接多个 DataFrame 或 Series', boost: 30 },
    { label: 'merge', type: 'function', detail: '(left, right, on=None, how="inner")', doc: '按键关联连接两个表', boost: 28 },
    { label: 'to_numeric', type: 'function', detail: '(arg, errors="coerce")', doc: '将列安全转换为数值类型', boost: 26 },
  ],
  os: [
    { label: 'path', type: 'namespace', detail: 'os.path 路径拼接与判断模块', boost: 36 },
    { label: 'listdir', type: 'function', detail: '(path=".") -> list[str]', doc: '列出目录下的文件名列表', boost: 32 },
    { label: 'makedirs', type: 'function', detail: '(name, exist_ok=True)', doc: '递归创建多级目录', boost: 34 },
    { label: 'walk', type: 'function', detail: '(top)', doc: '递归遍历目录树 (dirpath, dirnames, filenames)', boost: 28 },
    { label: 'environ', type: 'property', detail: '系统环境变量映射表', boost: 30 },
    { label: 'getenv', type: 'function', detail: '(key, default=None)', doc: '读取环境变量值', boost: 30 },
    { label: 'getcwd', type: 'function', detail: '() -> str', doc: '获取当前工作目录', boost: 28 },
    { label: 'remove', type: 'function', detail: '(path)', doc: '删除指定文件', boost: 24 },
  ],
  'os.path': [
    { label: 'join', type: 'function', detail: '(path, *paths) -> str', doc: '拼接多段文件目录路径', boost: 36 },
    { label: 'exists', type: 'function', detail: '(path) -> bool', doc: '判断文件或目录是否存在', boost: 35 },
    { label: 'isfile', type: 'function', detail: '(path) -> bool', doc: '判断是否为普通文件', boost: 30 },
    { label: 'isdir', type: 'function', detail: '(path) -> bool', doc: '判断是否为文件夹', boost: 30 },
    { label: 'dirname', type: 'function', detail: '(path) -> str', doc: '获取父目录路径', boost: 32 },
    { label: 'basename', type: 'function', detail: '(path) -> str', doc: '获取文件名部分', boost: 30 },
    { label: 'abspath', type: 'function', detail: '(path) -> str', doc: '转换为绝对路径', boost: 30 },
    { label: 'splitext', type: 'function', detail: '(path) -> (root, ext)', doc: '分离文件名主体与后缀名', boost: 28 },
  ],
  pathlib: [
    { label: 'Path', type: 'class', detail: '(*pathsegments)', doc: '跨平台面向对象文件系统路径类', boost: 38 },
  ],
  'pathlib.Path': [
    { label: 'cwd', type: 'method', detail: '() -> Path', doc: '返回当前工作目录 Path', boost: 30 },
    { label: 'exists', type: 'method', detail: '() -> bool', doc: '检查路径是否存在', boost: 35 },
    { label: 'is_file', type: 'method', detail: '() -> bool', doc: '检查是否为文件', boost: 30 },
    { label: 'is_dir', type: 'method', detail: '() -> bool', doc: '检查是否为目录', boost: 30 },
    { label: 'read_text', type: 'method', detail: '(encoding="utf-8") -> str', doc: '直接读取整个文本文件内容', boost: 35 },
    { label: 'write_text', type: 'method', detail: '(data, encoding="utf-8") -> int', doc: '将字符串直接写入文件', boost: 34 },
    { label: 'mkdir', type: 'method', detail: '(parents=True, exist_ok=True)', doc: '创建文件夹', boost: 34 },
    { label: 'glob', type: 'method', detail: '(pattern)', doc: '按通配符匹配子文件 (如 "*.py")', boost: 32 },
    { label: 'rglob', type: 'method', detail: '(pattern)', doc: '递归匹配所有子目录下的文件', boost: 30 },
    { label: 'resolve', type: 'method', detail: '() -> Path', doc: '解析为规范绝对路径', boost: 30 },
    { label: 'parent', type: 'property', detail: 'Path 父目录对象', boost: 34 },
    { label: 'name', type: 'property', detail: 'str 完整文件名', boost: 32 },
    { label: 'stem', type: 'property', detail: 'str 不含后缀的文件名', boost: 32 },
    { label: 'suffix', type: 'property', detail: 'str 文件扩展名 (如 ".py")', boost: 30 },
  ],
  json: [
    { label: 'loads', type: 'function', detail: '(s: str) -> Any', doc: '将 JSON 字符串解析为 Python 对象', boost: 36 },
    { label: 'dumps', type: 'function', detail: '(obj, ensure_ascii=False, indent=2) -> str', doc: '将对象序列化为 JSON 字符串', boost: 36 },
    { label: 'load', type: 'function', detail: '(fp) -> Any', doc: '从文件流读取并解析 JSON', boost: 32 },
    { label: 'dump', type: 'function', detail: '(obj, fp, ensure_ascii=False, indent=2)', doc: '将对象直接序列化写入文件流', boost: 32 },
  ],
  math: [
    { label: 'sin', type: 'function', detail: '(x)', doc: '正弦函数（弧度）', boost: 32 },
    { label: 'cos', type: 'function', detail: '(x)', doc: '余弦函数（弧度）', boost: 32 },
    { label: 'sqrt', type: 'function', detail: '(x)', doc: '平方根', boost: 34 },
    { label: 'exp', type: 'function', detail: '(x)', doc: '自然指数 e^x', boost: 30 },
    { label: 'log', type: 'function', detail: '(x[, base])', doc: '对数函数', boost: 30 },
    { label: 'ceil', type: 'function', detail: '(x) -> int', doc: '向上取整', boost: 28 },
    { label: 'floor', type: 'function', detail: '(x) -> int', doc: '向下取整', boost: 28 },
    { label: 'isclose', type: 'function', detail: '(a, b, *, rel_tol=1e-9, abs_tol=0.0)', doc: '浮点数近似相等判断', boost: 28 },
    { label: 'pi', type: 'constant', detail: '3.141592653589793', boost: 35 },
    { label: 'e', type: 'constant', detail: '2.718281828459045', boost: 26 },
  ],
  sys: [
    { label: 'argv', type: 'property', detail: 'list[str] 命令行参数列表', boost: 34 },
    { label: 'path', type: 'property', detail: 'list[str] 模块搜索路径列表', boost: 34 },
    { label: 'exit', type: 'function', detail: '(code=0)', doc: '退出当前进程', boost: 30 },
    { label: 'stdout', type: 'property', detail: '标准输出流', boost: 28 },
    { label: 'stderr', type: 'property', detail: '标准错误流', boost: 28 },
  ],
  re: [
    { label: 'search', type: 'function', detail: '(pattern, string, flags=0)', doc: '扫描字符串查找第一个正则匹配', boost: 34 },
    { label: 'match', type: 'function', detail: '(pattern, string, flags=0)', doc: '从字符串起始位置匹配正则', boost: 30 },
    { label: 'findall', type: 'function', detail: '(pattern, string, flags=0) -> list', doc: '返回所有不重叠匹配列表', boost: 34 },
    { label: 'sub', type: 'function', detail: '(pattern, repl, string, count=0)', doc: '使用正则表达式替换子串', boost: 34 },
    { label: 'compile', type: 'function', detail: '(pattern, flags=0)', doc: '预编译正则表达式对象', boost: 30 },
  ],
  time: [
    { label: 'perf_counter', type: 'function', detail: '() -> float', doc: '高精度性能计时器（测量代码耗时首选）', boost: 36 },
    { label: 'time', type: 'function', detail: '() -> float', doc: '返回当前 Unix 秒级时间戳', boost: 34 },
    { label: 'sleep', type: 'function', detail: '(secs)', doc: '暂停当前线程指定秒数', boost: 32 },
    { label: 'strftime', type: 'function', detail: '(format[, t]) -> str', doc: '格式化时间字符串 (如 "%Y-%m-%d %H:%M:%S")', boost: 28 },
  ],
  typing: [
    { label: 'Any', type: 'class', detail: '任意类型注解', boost: 32 },
    { label: 'Optional', type: 'class', detail: 'Optional[T] 可选类型', boost: 34 },
    { label: 'Union', type: 'class', detail: 'Union[A, B] 联合类型', boost: 28 },
    { label: 'List', type: 'class', detail: 'List[T]', boost: 28 },
    { label: 'Dict', type: 'class', detail: 'Dict[K, V]', boost: 28 },
    { label: 'Tuple', type: 'class', detail: 'Tuple[...]', boost: 28 },
    { label: 'Callable', type: 'class', detail: 'Callable[[Args], Ret]', boost: 28 },
    { label: 'Literal', type: 'class', detail: 'Literal["a", "b"]', boost: 26 },
  ],
};

/** Default common aliases widely used even before explicit `as` is parsed */
const DEFAULT_PYTHON_ALIASES: Record<string, string> = {
  np: 'numpy',
  nn: 'torch.nn',
  F: 'torch.nn.functional',
  optim: 'torch.optim',
  plt: 'matplotlib.pyplot',
  pd: 'pandas',
  Path: 'pathlib.Path',
};

const NN_MODULE_SELF_METHODS: CatalogEntry[] = [
  { label: 'parameters', type: 'method', detail: '(recurse=True)', doc: '迭代返回模型全部可训练参数', boost: 22 },
  { label: 'named_parameters', type: 'method', detail: '(recurse=True)', doc: '迭代返回 (name, param) 参数对', boost: 20 },
  { label: 'register_buffer', type: 'method', detail: '(name, tensor, persistent=True)', doc: '注册随设备迁移但不参与梯度更新的常量张量', boost: 24 },
  { label: 'state_dict', type: 'method', detail: '() -> dict', doc: '导出模型权重状态字典', boost: 22 },
  { label: 'load_state_dict', type: 'method', detail: '(state_dict, strict=True)', doc: '加载模型权重状态字典', boost: 22 },
  { label: 'train', type: 'method', detail: '(mode=True)', doc: '切换为训练模式', boost: 20 },
  { label: 'eval', type: 'method', detail: '()', doc: '切换为评估推理模式', boost: 22 },
  { label: 'to', type: 'method', detail: '(device_or_dtype)', doc: '迁移模块参数到指定 GPU/CPU 设备或精度', boost: 24 },
];

const GENERIC_PYTHON_OBJECT_MEMBERS: CatalogEntry[] = [
  // str / list / dict
  { label: 'append', type: 'method', detail: '(item)', doc: '列表末尾追加元素', boost: 24 },
  { label: 'extend', type: 'method', detail: '(iterable)', doc: '批量追加多个元素', boost: 20 },
  { label: 'get', type: 'method', detail: '(key, default=None)', doc: '安全读取字典键值', boost: 26 },
  { label: 'items', type: 'method', detail: '()', doc: '返回字典 (key, value) 视图', boost: 26 },
  { label: 'keys', type: 'method', detail: '()', doc: '返回字典全部键视图', boost: 22 },
  { label: 'values', type: 'method', detail: '()', doc: '返回字典全部值视图', boost: 22 },
  { label: 'strip', type: 'method', detail: '(chars=None)', doc: '去除首尾空白或指定字符', boost: 25 },
  { label: 'split', type: 'method', detail: '(sep=None, maxsplit=-1)', doc: '分割字符串为列表', boost: 25 },
  { label: 'join', type: 'method', detail: '(iterable)', doc: '连接字符串序列', boost: 24 },
  { label: 'replace', type: 'method', detail: '(old, new, count=-1)', doc: '替换子字符串', boost: 24 },
  { label: 'startswith', type: 'method', detail: '(prefix) -> bool', doc: '检查字符串前缀', boost: 22 },
  { label: 'endswith', type: 'method', detail: '(suffix) -> bool', doc: '检查字符串后缀', boost: 22 },
  { label: 'lower', type: 'method', detail: '() -> str', doc: '转为小写字母', boost: 20 },
  { label: 'upper', type: 'method', detail: '() -> str', doc: '转为大写字母', boost: 20 },
  // Tensor / ndarray
  { label: 'shape', type: 'property', detail: 'tuple 维度尺寸', doc: '数组或张量的各维尺寸', boost: 30 },
  { label: 'dtype', type: 'property', detail: '数值精度类型', boost: 26 },
  { label: 'device', type: 'property', detail: 'Tensor 所在设备 (cpu/cuda)', boost: 24 },
  { label: 'reshape', type: 'method', detail: '(*shape)', doc: '重塑张量/数组形状', boost: 28 },
  { label: 'permute', type: 'method', detail: '(*dims)', doc: '重排 Tensor 维度顺序', boost: 24 },
  { label: 'transpose', type: 'method', detail: '(dim0, dim1)', doc: '交换维度', boost: 24 },
  { label: 'unsqueeze', type: 'method', detail: '(dim)', doc: '扩充长度为 1 的新维度', boost: 24 },
  { label: 'squeeze', type: 'method', detail: '(dim=None)', doc: '压缩长度为 1 的维度', boost: 22 },
  { label: 'detach', type: 'method', detail: '() -> Tensor', doc: '从计算图分离张量（停止梯度追踪）', boost: 26 },
  { label: 'cpu', type: 'method', detail: '() -> Tensor', doc: '拷贝张量到 CPU 内存', boost: 24 },
  { label: 'cuda', type: 'method', detail: '() -> Tensor', doc: '拷贝张量到 CUDA 显存', boost: 22 },
  { label: 'to', type: 'method', detail: '(device_or_dtype)', doc: '转换张量/模型到目标设备或数据类型', boost: 28 },
  { label: 'numpy', type: 'method', detail: '() -> ndarray', doc: '转换为 NumPy 数组', boost: 26 },
  { label: 'item', type: 'method', detail: '() -> float | int', doc: '提取标量张量的 Python 数值', boost: 26 },
  { label: 'backward', type: 'method', detail: '()', doc: '反向传播计算梯度', boost: 24 },
  { label: 'zero_grad', type: 'method', detail: '(set_to_none=True)', doc: '清空优化器或模型梯度', boost: 24 },
  { label: 'step', type: 'method', detail: '()', doc: '执行一步优化器参数更新或学习率调度', boost: 24 },
  // Path methods
  { label: 'read_text', type: 'method', detail: '(encoding="utf-8")', doc: 'Path 读取文本内容', boost: 20 },
  { label: 'write_text', type: 'method', detail: '(data, encoding="utf-8")', doc: 'Path 写入文本内容', boost: 20 },
  { label: 'exists', type: 'method', detail: '() -> bool', doc: 'Path 判断路径是否存在', boost: 20 },
];

// ============================================================================
// 2. JavaScript / TypeScript / Rust / PowerShell / Batch / SQL / Markdown Catalogs
// ============================================================================

const JS_TS_SNIPPETS: Completion[] = [
  snippetCompletion('function ${1:name}(${2:params}) {\n\t${0}\n}', {
    label: 'fn',
    detail: 'function 函数声明',
    type: 'keyword',
    boost: 32,
    section: '代码片段',
  }),
  snippetCompletion('async function ${1:name}(${2:params}) {\n\t${0}\n}', {
    label: 'afn',
    detail: 'async function 异步函数',
    type: 'keyword',
    boost: 28,
    section: '代码片段',
  }),
  snippetCompletion('console.log(${0});', {
    label: 'clg',
    detail: 'console.log(...)',
    type: 'function',
    boost: 35,
    section: '代码片段',
  }),
  snippetCompletion('for (const ${1:item} of ${2:items}) {\n\t${0}\n}', {
    label: 'forof',
    detail: 'for (const x of list)',
    type: 'keyword',
    boost: 26,
    section: '代码片段',
  }),
  snippetCompletion('try {\n\t${1}\n} catch (${2:err}) {\n\tconsole.error(${2:err});\n}', {
    label: 'try',
    detail: 'try ... catch 异常处理',
    type: 'keyword',
    boost: 25,
    section: '代码片段',
  }),
];

const JS_TS_GLOBALS: CatalogEntry[] = [
  { label: 'console', type: 'namespace', detail: '控制台输出对象', boost: 32 },
  { label: 'JSON', type: 'namespace', detail: 'JSON 序列化与解析', boost: 30 },
  { label: 'Math', type: 'namespace', detail: '数学常数与函数对象', boost: 28 },
  { label: 'Object', type: 'class', detail: '对象工具方法 (keys / entries / assign)', boost: 28 },
  { label: 'Array', type: 'class', detail: '数组工具方法 (isArray / from)', boost: 28 },
  { label: 'Promise', type: 'class', detail: '异步 Promise (all / resolve)', boost: 28 },
  { label: 'fetch', type: 'function', detail: '(input, init?) => Promise<Response>', doc: '发起网络 HTTP 请求', boost: 28 },
  { label: 'setTimeout', type: 'function', detail: '(handler, timeoutMs)', doc: '延时执行回调', boost: 24 },
  { label: 'clearTimeout', type: 'function', detail: '(id)', doc: '取消延时定时器', boost: 20 },
  { label: 'Map', type: 'class', detail: 'new Map<K, V>()', boost: 24 },
  { label: 'Set', type: 'class', detail: 'new Set<T>()', boost: 24 },
  { label: 'document', type: 'namespace', detail: 'DOM 文档对象', boost: 24 },
  { label: 'window', type: 'namespace', detail: '全局窗口对象', boost: 22 },
];

const JS_TS_RECEIVERS: Record<string, CatalogEntry[]> = {
  console: [
    { label: 'log', type: 'method', detail: '(...data)', doc: '打印常规日志', boost: 36 },
    { label: 'error', type: 'method', detail: '(...data)', doc: '打印错误日志', boost: 32 },
    { label: 'warn', type: 'method', detail: '(...data)', doc: '打印警告信息', boost: 30 },
    { label: 'table', type: 'method', detail: '(tabularData)', doc: '以表格形式打印数组/对象', boost: 26 },
    { label: 'time', type: 'method', detail: '(label)', doc: '启动命名计时器', boost: 24 },
    { label: 'timeEnd', type: 'method', detail: '(label)', doc: '结束计时并打印耗时', boost: 24 },
  ],
  JSON: [
    { label: 'parse', type: 'method', detail: '(text: string)', doc: '解析 JSON 字符串', boost: 36 },
    { label: 'stringify', type: 'method', detail: '(value, replacer?, space=2)', doc: '序列化为 JSON 字符串', boost: 36 },
  ],
  Math: [
    { label: 'max', type: 'method', detail: '(...values)', boost: 32 },
    { label: 'min', type: 'method', detail: '(...values)', boost: 32 },
    { label: 'floor', type: 'method', detail: '(x)', boost: 30 },
    { label: 'ceil', type: 'method', detail: '(x)', boost: 30 },
    { label: 'round', type: 'method', detail: '(x)', boost: 30 },
    { label: 'abs', type: 'method', detail: '(x)', boost: 28 },
    { label: 'sqrt', type: 'method', detail: '(x)', boost: 28 },
    { label: 'sin', type: 'method', detail: '(x)', boost: 26 },
    { label: 'cos', type: 'method', detail: '(x)', boost: 26 },
    { label: 'random', type: 'method', detail: '() => [0, 1)', boost: 28 },
    { label: 'PI', type: 'constant', detail: '3.141592653589793', boost: 30 },
  ],
  Object: [
    { label: 'keys', type: 'method', detail: '(obj) => string[]', boost: 34 },
    { label: 'values', type: 'method', detail: '(obj) => any[]', boost: 32 },
    { label: 'entries', type: 'method', detail: '(obj) => [key, val][]', boost: 34 },
    { label: 'fromEntries', type: 'method', detail: '(entries)', boost: 28 },
    { label: 'assign', type: 'method', detail: '(target, ...sources)', boost: 26 },
  ],
  Array: [
    { label: 'isArray', type: 'method', detail: '(val) => boolean', boost: 34 },
    { label: 'from', type: 'method', detail: '(iterable, mapFn?)', boost: 32 },
  ],
  Promise: [
    { label: 'all', type: 'method', detail: '(promises)', boost: 34 },
    { label: 'resolve', type: 'method', detail: '(value)', boost: 30 },
    { label: 'reject', type: 'method', detail: '(reason)', boost: 26 },
  ],
};

const JS_GENERIC_MEMBERS: CatalogEntry[] = [
  { label: 'length', type: 'property', detail: 'number 长度', boost: 32 },
  { label: 'map', type: 'method', detail: '(fn) => Array', boost: 34 },
  { label: 'filter', type: 'method', detail: '(predicate) => Array', boost: 34 },
  { label: 'forEach', type: 'method', detail: '(fn) => void', boost: 30 },
  { label: 'reduce', type: 'method', detail: '(reducer, initialValue)', boost: 28 },
  { label: 'find', type: 'method', detail: '(predicate)', boost: 30 },
  { label: 'some', type: 'method', detail: '(predicate) => boolean', boost: 26 },
  { label: 'every', type: 'method', detail: '(predicate) => boolean', boost: 24 },
  { label: 'includes', type: 'method', detail: '(searchElement) => boolean', boost: 30 },
  { label: 'push', type: 'method', detail: '(...items)', boost: 30 },
  { label: 'slice', type: 'method', detail: '(start?, end?)', boost: 28 },
  { label: 'join', type: 'method', detail: '(separator=",")', boost: 28 },
  { label: 'trim', type: 'method', detail: '() => string', boost: 28 },
  { label: 'split', type: 'method', detail: '(separator)', boost: 28 },
  { label: 'replace', type: 'method', detail: '(pattern, replacement)', boost: 26 },
  { label: 'then', type: 'method', detail: '(onFulfilled)', boost: 28 },
  { label: 'catch', type: 'method', detail: '(onRejected)', boost: 26 },
];

const RUST_COMPLETIONS: Completion[] = [
  snippetCompletion('fn ${1:name}(${2:args}) -> ${3:Result<(), String>} {\n\t${0}\n}', {
    label: 'fn',
    detail: 'Rust 函数模板',
    type: 'keyword',
    boost: 34,
    section: '代码片段',
  }),
  snippetCompletion('println!("${1:{}}", ${0:val});', {
    label: 'println!',
    detail: '格式化打印输出宏',
    type: 'function',
    boost: 36,
    section: '常用宏与标准库',
  }),
  snippetCompletion('format!("${1:{}}", ${0:val})', {
    label: 'format!',
    detail: '格式化构造 String 宏',
    type: 'function',
    boost: 32,
    section: '常用宏与标准库',
  }),
  ...[
    { label: 'Vec', type: 'class', detail: 'Vec<T> 动态数组', boost: 30 },
    { label: 'String', type: 'class', detail: 'UTF-8 字符串', boost: 30 },
    { label: 'Option', type: 'class', detail: 'Option<T> (Some / None)', boost: 30 },
    { label: 'Result', type: 'class', detail: 'Result<T, E> (Ok / Err)', boost: 30 },
    { label: 'Some', type: 'function', detail: '(value)', boost: 28 },
    { label: 'None', type: 'constant', detail: 'Option::None', boost: 28 },
    { label: 'Ok', type: 'function', detail: '(value)', boost: 28 },
    { label: 'Err', type: 'function', detail: '(err)', boost: 28 },
    { label: 'HashMap', type: 'class', detail: 'std::collections::HashMap', boost: 26 },
    { label: 'HashSet', type: 'class', detail: 'std::collections::HashSet', boost: 24 },
  ].map((e) => toCompletion(e as CatalogEntry, '常用宏与标准库')),
];

const RUST_DOT_MEMBERS: CatalogEntry[] = [
  { label: 'iter', type: 'method', detail: '()', boost: 32 },
  { label: 'into_iter', type: 'method', detail: '()', boost: 28 },
  { label: 'map', type: 'method', detail: '(|x| ...)', boost: 32 },
  { label: 'filter', type: 'method', detail: '(|x| ...)', boost: 30 },
  { label: 'collect', type: 'method', detail: '::<Vec<_>>()', boost: 32 },
  { label: 'unwrap', type: 'method', detail: '()', boost: 30 },
  { label: 'unwrap_or', type: 'method', detail: '(default)', boost: 30 },
  { label: 'unwrap_or_default', type: 'method', detail: '()', boost: 28 },
  { label: 'expect', type: 'method', detail: '(msg)', boost: 28 },
  { label: 'clone', type: 'method', detail: '()', boost: 32 },
  { label: 'to_string', type: 'method', detail: '() -> String', boost: 32 },
  { label: 'as_str', type: 'method', detail: '() -> &str', boost: 28 },
  { label: 'len', type: 'method', detail: '() -> usize', boost: 30 },
  { label: 'is_empty', type: 'method', detail: '() -> bool', boost: 28 },
  { label: 'push', type: 'method', detail: '(value)', boost: 28 },
];

const POWERSHELL_COMPLETIONS: Completion[] = [
  ...[
    { label: 'Write-Host', type: 'function', detail: '"消息文本" -ForegroundColor Cyan', doc: '输出彩色提示文本到控制台', boost: 34 },
    { label: 'Get-ChildItem', type: 'function', detail: '-Path . -Filter *.py -Recurse', doc: '列出目录下的文件与子目录', boost: 34 },
    { label: 'Set-Location', type: 'function', detail: '-LiteralPath $PSScriptRoot', doc: '切换当前工作目录', boost: 30 },
    { label: 'Test-Path', type: 'function', detail: '-LiteralPath $path', doc: '检查文件或目录是否存在', boost: 32 },
    { label: 'New-Item', type: 'function', detail: '-ItemType Directory -Force -Path ...', doc: '新建目录或文件', boost: 30 },
    { label: 'Copy-Item', type: 'function', detail: '-Path ... -Destination ... -Force', doc: '复制文件或目录', boost: 30 },
    { label: 'Remove-Item', type: 'function', detail: '-Recurse -Force -ErrorAction SilentlyContinue', doc: '删除文件或目录', boost: 28 },
    { label: 'Get-Content', type: 'function', detail: '-Path ... -Encoding UTF8', doc: '读取文本文件内容', boost: 30 },
    { label: 'Set-Content', type: 'function', detail: '-Path ... -Value ... -Encoding UTF8', doc: '写入文本内容到文件', boost: 28 },
    { label: 'Start-Process', type: 'function', detail: '-FilePath ... -ArgumentList ...', doc: '启动外部程序进程', boost: 28 },
    { label: 'Stop-Process', type: 'function', detail: '-Name ... -Force', doc: '终止指定进程', boost: 28 },
    { label: 'Get-Process', type: 'function', detail: '-Name ...', doc: '查询运行中进程', boost: 28 },
    { label: 'Invoke-RestMethod', type: 'function', detail: '-Uri ... -Method Get', doc: '调用 HTTP JSON 接口', boost: 26 },
    { label: 'ConvertFrom-Json', type: 'function', detail: '解析 JSON 字符串为对象', boost: 26 },
    { label: 'ConvertTo-Json', type: 'function', detail: '-Depth 5', boost: 26 },
    { label: 'ForEach-Object', type: 'keyword', detail: '{ $_ }', boost: 26 },
    { label: 'Where-Object', type: 'keyword', detail: '{ $_ }', boost: 26 },
    { label: '$ErrorActionPreference', type: 'variable', detail: '= "Stop"', boost: 30 },
    { label: '$PSScriptRoot', type: 'variable', detail: '当前脚本所在目录路径', boost: 32 },
  ].map((e) => toCompletion(e as CatalogEntry, 'PowerShell 命令')),
];

const BATCH_COMPLETIONS: Completion[] = [
  snippetCompletion('@echo off\nchcp 65001 >nul\ncd /d "%~dp0"\n${0}', {
    label: 'bathead',
    detail: 'UTF-8 标准批处理脚本头',
    type: 'keyword',
    boost: 36,
    section: 'Batch 模板',
  }),
  ...[
    { label: '@echo off', type: 'keyword', detail: '关闭命令回显', boost: 34 },
    { label: 'chcp 65001 >nul', type: 'function', detail: '切换控制台编码为 UTF-8', boost: 32 },
    { label: 'setlocal enabledelayedexpansion', type: 'keyword', detail: '启用延迟环境变量扩展', boost: 28 },
    { label: 'cd /d "%~dp0"', type: 'function', detail: '切换到当前 bat 所在目录', boost: 32 },
    { label: 'if exist', type: 'keyword', detail: '"path" (...)', boost: 28 },
    { label: 'taskkill /F /IM', type: 'function', detail: 'process.exe >nul 2>nul', boost: 26 },
    { label: 'start ""', type: 'function', detail: '"program.exe"', boost: 28 },
    { label: 'pause', type: 'keyword', detail: '按任意键继续', boost: 26 },
    { label: 'exit /b 0', type: 'keyword', detail: '退出当前脚本并返回状态码', boost: 26 },
  ].map((e) => toCompletion(e as CatalogEntry, 'Batch 指令')),
];

const SQL_COMPLETIONS: Completion[] = [
  'SELECT',
  'FROM',
  'WHERE',
  'JOIN',
  'LEFT JOIN',
  'INNER JOIN',
  'GROUP BY',
  'ORDER BY',
  'HAVING',
  'LIMIT',
  'INSERT INTO',
  'VALUES',
  'UPDATE',
  'SET',
  'DELETE FROM',
  'CREATE TABLE',
  'COUNT',
  'SUM',
  'AVG',
  'MIN',
  'MAX',
  'COALESCE',
  'DISTINCT',
].map((kw) => ({ label: kw, type: 'keyword', boost: 20, section: 'SQL 关键字' }));

const MARKDOWN_COMPLETIONS: Completion[] = [
  snippetCompletion('```${1:python}\n${0}\n```', {
    label: 'codeblock',
    detail: '代码块 ```python ... ```',
    type: 'keyword',
    boost: 34,
    section: 'Markdown 模板',
  }),
  snippetCompletion('> [!TIP]\n> ${0:在此输入关键提示内容}', {
    label: 'tip',
    detail: '> [!TIP] 高亮提示卡片',
    type: 'keyword',
    boost: 30,
    section: 'Markdown 模板',
  }),
  snippetCompletion('> [!NOTE]\n> ${0:在此输入背景说明}', {
    label: 'note',
    detail: '> [!NOTE] 说明卡片',
    type: 'keyword',
    boost: 28,
    section: 'Markdown 模板',
  }),
  snippetCompletion('> [!IMPORTANT]\n> ${0:在此输入重要注意事项}', {
    label: 'important',
    detail: '> [!IMPORTANT] 重要卡片',
    type: 'keyword',
    boost: 28,
    section: 'Markdown 模板',
  }),
  snippetCompletion('$$\n${0:u(x, t) = \\sum_{k=1}^{N} c_k \\sin(k \\pi x)}\n$$', {
    label: 'math',
    detail: '$$ LaTeX 独立公式块 $$',
    type: 'keyword',
    boost: 30,
    section: 'Markdown 模板',
  }),
];

// ============================================================================
// 3. Fast Live Current-Document Symbol, Class `self.`, and Import Alias Analyzer
// ============================================================================

export function extractImportedPythonModules(code: string): string[] {
  const modules = new Set<string>();
  const lines = code.split(/\r?\n/);
  const limit = Math.min(lines.length, 400);

  for (let i = 0; i < limit; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const fromMatch = /^from\s+([A-Za-z_][\w.]*)\s+import\s+(.+)$/.exec(trimmed);
    if (fromMatch) {
      const baseMod = fromMatch[1];
      modules.add(baseMod);
      const rootPkg = baseMod.split('.')[0];
      if (rootPkg) modules.add(rootPkg);
      continue;
    }

    const impMatch = /^import\s+(.+)$/.exec(trimmed);
    if (impMatch) {
      const parts = impMatch[1].split(',');
      for (const part of parts) {
        const clean = part.trim().split(/\s+as\s+/)[0]?.trim();
        if (clean && /^[A-Za-z_][\w.]*$/.test(clean)) {
          modules.add(clean);
          const rootPkg = clean.split('.')[0];
          if (rootPkg) modules.add(rootPkg);
        }
      }
    }
  }
  return Array.from(modules);
}

export function analyzeDocumentForCompletions(
  code: string,
  language: string
): AnalyzedDocument {
  const aliases = new Map<string, string>();
  const localCompletions: RankedCompletion[] = [];
  const localSignatures = new Map<string, SignatureRecord>();
  const classMembers = new Map<
    string,
    {
      inheritsNnModule: boolean;
      completions: RankedCompletion[];
      signatures: Map<string, SignatureRecord>;
    }
  >();
  const seenTopLabels = new Map<string, RankedCompletion>();
  const scopedVarLines = new Map<string, number>();
  const identifierLines = new Map<string, number>();
  const classSpans: { name: string; startLine: number; endLine: number; indent: number }[] = [];
  const fnSpans: FunctionScopeInfo[] = [];

  if (language === 'python') {
    for (const [k, v] of Object.entries(DEFAULT_PYTHON_ALIASES)) {
      aliases.set(k, v);
    }
  }

  const lines = code.split(/\r?\n/);

  if (language === 'python') {
    let activeClass: {
      name: string;
      indent: number;
      startLine: number;
      seenMembers: Set<string>;
    } | null = null;
    let activeFn: FunctionScopeInfo | null = null;

    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      const raw = lines[i];
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const indent = raw.length - raw.trimStart().length;
      if (activeFn && indent <= activeFn.indent && !trimmed.startsWith('@')) {
        activeFn.endLine = i;
        fnSpans.push(activeFn);
        activeFn = null;
      }
      if (activeClass && indent <= activeClass.indent && !trimmed.startsWith('@')) {
        classSpans.push({
          name: activeClass.name,
          startLine: activeClass.startLine,
          endLine: i,
          indent: activeClass.indent,
        });
        activeClass = null;
      }

      // 1. Parse `import X as Y`
      const impMatch = /^import\s+(.+)$/.exec(trimmed);
      if (impMatch) {
        for (const seg of impMatch[1].split(',')) {
          const m = /^([A-Za-z_][\w.]*)(?:\s+as\s+([A-Za-z_][\w]*))?$/.exec(seg.trim());
          if (m) {
            const target = m[1];
            const localName = m[2] || target.split('.')[0];
            aliases.set(localName, target);
            if (!seenTopLabels.has(localName)) {
              const item: RankedCompletion = {
                label: localName,
                type: 'namespace',
                detail: `import ${target}`,
                boost: 45,
                _origin: 'imported-symbol',
                _defLine: lineNo,
              };
              seenTopLabels.set(localName, item);
              localCompletions.push(item);
            }
          }
        }
        continue;
      }

      // 2. Parse `from X import a as b, c`
      const fromMatch = /^from\s+([A-Za-z_][\w.]*)\s+import\s+(.+)$/.exec(trimmed);
      if (fromMatch) {
        const modPath = fromMatch[1];
        const namesPart = fromMatch[2].replace(/[()]/g, '');
        for (const seg of namesPart.split(',')) {
          const m = /^([A-Za-z_][\w]*)(?:\s+as\s+([A-Za-z_][\w]*))?$/.exec(seg.trim());
          if (m && m[1] !== '*') {
            const origName = m[1];
            const localName = m[2] || origName;
            const fullTarget = `${modPath}.${origName}`;
            aliases.set(localName, fullTarget);

            const modEntries = PYTHON_MODULE_CATALOG[modPath];
            const curated = modEntries?.find((e) => e.label === origName);

            if (!seenTopLabels.has(localName)) {
              const item: RankedCompletion = {
                label: localName,
                type: curated?.type || (/^[A-Z]/.test(origName) ? 'class' : 'function'),
                detail: curated?.detail || `from ${modPath}`,
                info: curated?.doc,
                boost: 46,
                _origin: 'imported-symbol',
                _defLine: lineNo,
              };
              seenTopLabels.set(localName, item);
              localCompletions.push(item);
            }
            if (curated?.detail?.startsWith('(')) {
              localSignatures.set(localName, {
                label: localName,
                params: curated.detail,
                doc: curated.doc,
              });
            }
          }
        }
        continue;
      }

      // 3. Parse `class Foo(Bases):`
      const classMatch = /^class\s+([A-Za-z_][\w]*)(?:\(([^)]*)\))?\s*:/.exec(trimmed);
      if (classMatch) {
        const className = classMatch[1];
        const bases = classMatch[2] || '';
        const inheritsNnModule = /\bModule\b/.test(bases);
        activeClass = {
          name: className,
          indent,
          startLine: lineNo,
          seenMembers: new Set<string>(),
        };
        if (!classMembers.has(className)) {
          classMembers.set(className, {
            inheritsNnModule,
            completions: [],
            signatures: new Map(),
          });
        }
        if (!seenTopLabels.has(className)) {
          const item: RankedCompletion = {
            label: className,
            type: 'class',
            detail: bases ? `class (${bases})` : 'class',
            boost: 46,
            _origin: 'file-class',
            _defLine: lineNo,
          };
          seenTopLabels.set(className, item);
          localCompletions.push(item);
        }
        continue;
      }

      // 4. Parse `def func(...)` or method inside `activeClass`
      const defMatch = /^(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\((.*)/.exec(trimmed);
      if (defMatch) {
        const fnName = defMatch[1];
        let sigRest = '(' + defMatch[2];
        let look = i + 1;
        while (!sigRest.includes(')') && look < lines.length && look <= i + 5) {
          sigRest += ' ' + lines[look].trim();
          look += 1;
        }
        const closeIdx = sigRest.indexOf(')');
        const rawParams = closeIdx >= 0 ? sigRest.slice(0, closeIdx + 1) : '()';

        let doc: string | undefined;
        for (let k = look; k < Math.min(lines.length, look + 3); k++) {
          const dt = lines[k].trim();
          if (!dt) continue;
          if (dt.startsWith('"""') || dt.startsWith("'''")) {
            const q = dt.slice(0, 3);
            const inner = dt.slice(3).replace(new RegExp(`${q}$`), '').trim();
            doc = inner || lines[k + 1]?.trim().replace(new RegExp(`${q}$`), '').trim();
          }
          break;
        }

        const paramNames: string[] = [];
        const innerParams = rawParams.slice(1, -1).split(',');
        for (const p of innerParams) {
          const pName = p.trim().replace(/^\*+/, '').split(/[:=]/)[0]?.trim();
          if (pName && pName !== 'self' && pName !== 'cls' && /^[A-Za-z_][\w]*$/.test(pName)) {
            paramNames.push(pName);
          }
        }

        activeFn = {
          name: fnName,
          startLine: lineNo,
          endLine: lines.length,
          indent,
          params: paramNames,
          localVars: new Map<string, number>(),
        };

        if (activeClass && indent > activeClass.indent) {
          const bucket = classMembers.get(activeClass.name);
          if (bucket && !activeClass.seenMembers.has(fnName)) {
            activeClass.seenMembers.add(fnName);
            const displayParams = rawParams.replace(/^\(\s*self\s*,?\s*/, '(');
            if (fnName === '__init__') {
              localSignatures.set(activeClass.name, {
                label: activeClass.name,
                params: displayParams,
                doc,
              });
            } else if (!fnName.startsWith('__')) {
              bucket.completions.push({
                label: fnName,
                type: 'method',
                detail: displayParams,
                info: doc,
                boost: 55,
                _origin: 'self-member',
                _defLine: lineNo,
              });
              bucket.signatures.set(fnName, {
                label: `${activeClass.name}.${fnName}`,
                params: displayParams,
                doc,
              });
            }
          }
        } else if (!seenTopLabels.has(fnName)) {
          const item: RankedCompletion = {
            label: fnName,
            type: 'function',
            detail: rawParams,
            info: doc,
            boost: 48,
            _origin: 'file-fn',
            _defLine: lineNo,
          };
          seenTopLabels.set(fnName, item);
          localCompletions.push(item);
          localSignatures.set(fnName, {
            label: fnName,
            params: rawParams,
            doc,
          });
        }
        continue;
      }

      // 5. Parse `self.attr = ...` inside classes
      if (activeClass && indent > activeClass.indent) {
        const selfAttrRegex = /\bself\.([A-Za-z_][\w]*)\s*(?::[^=]+)?=/g;
        let sm: RegExpExecArray | null;
        while ((sm = selfAttrRegex.exec(trimmed)) !== null) {
          const attrName = sm[1];
          const bucket = classMembers.get(activeClass.name);
          if (bucket && !activeClass.seenMembers.has(attrName)) {
            activeClass.seenMembers.add(attrName);
            bucket.completions.push({
              label: attrName,
              type: 'property',
              detail: `self.${attrName}`,
              boost: 58,
              _origin: 'self-member',
              _defLine: lineNo,
            });
          }
        }
      }

      // 6. Parse `for x, y in ...:` loop variables
      const forVarMatch = /^(?:async\s+)?for\s+([A-Za-z_][\w\s,]*)\s+in\s+/.exec(trimmed);
      if (forVarMatch) {
        for (const rawV of forVarMatch[1].split(',')) {
          const v = rawV.trim();
          if (v && v !== '_' && /^[A-Za-z_][\w]*$/.test(v)) {
            scopedVarLines.set(v, lineNo);
            if (activeFn) activeFn.localVars.set(v, lineNo);
          }
        }
      }

      // 7. Parse variable assignments `x = ...` (both top-level and inside `if __name__` / functions!)
      const assignMatch = /^([A-Za-z_][\w]*)\s*(?::[^=]+)?=\s*(.+)$/.exec(trimmed);
      if (assignMatch && !trimmed.startsWith('==')) {
        const varName = assignMatch[1];
        const rhs = assignMatch[2].trim();
        if (activeFn) {
          activeFn.localVars.set(varName, lineNo);
        } else {
          const existing = seenTopLabels.get(varName);
          if (!existing) {
            const item: RankedCompletion = {
              label: varName,
              type: /^[A-Z0-9_]+$/.test(varName) ? 'constant' : 'variable',
              detail: rhs.slice(0, 38),
              boost: 48,
              _origin: 'file-var',
              _defLine: lineNo,
            };
            seenTopLabels.set(varName, item);
            localCompletions.push(item);
          } else {
            existing._defLine = lineNo;
          }
        }
        scopedVarLines.set(varName, lineNo);

        if (/^(?:pathlib\.)?Path\s*\(/.test(rhs)) {
          aliases.set(varName, 'pathlib.Path');
        }
      }
    }

    if (activeFn) {
      activeFn.endLine = lines.length;
      fnSpans.push(activeFn);
    }
    if (activeClass) {
      classSpans.push({
        name: activeClass.name,
        startLine: activeClass.startLine,
        endLine: lines.length,
        indent: activeClass.indent,
      });
    }
  } else {
    // JS / TS / Rust / PS1 local functions, classes, and variables
    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      const t = lines[i].trim().replace(/^export\s+(?:default\s+)?/, '').replace(/^pub\s+/, '');
      if (!t || t.startsWith('//') || t.startsWith('#')) continue;

      const fnMatch = /^(?:async\s+)?(?:function|fn)\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*(\([^)]*\))/.exec(t);
      if (fnMatch) {
        const name = fnMatch[1];
        const params = fnMatch[2];
        if (!seenTopLabels.has(name)) {
          const item: RankedCompletion = {
            label: name,
            type: 'function',
            detail: params,
            boost: 48,
            _origin: 'file-fn',
            _defLine: lineNo,
          };
          seenTopLabels.set(name, item);
          localCompletions.push(item);
          localSignatures.set(name, { label: name, params });
        }
        continue;
      }

      const clsMatch = /^(?:class|struct|enum|interface|type)\s+([A-Za-z_$][\w$]*)/.exec(t);
      if (clsMatch && !seenTopLabels.has(clsMatch[1])) {
        const item: RankedCompletion = {
          label: clsMatch[1],
          type: 'class',
          boost: 46,
          _origin: 'file-class',
          _defLine: lineNo,
        };
        seenTopLabels.set(clsMatch[1], item);
        localCompletions.push(item);
        continue;
      }

      const varMatch = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(t);
      if (varMatch && !seenTopLabels.has(varMatch[1])) {
        const item: RankedCompletion = {
          label: varMatch[1],
          type: 'variable',
          boost: 46,
          _origin: 'file-var',
          _defLine: lineNo,
        };
        seenTopLabels.set(varMatch[1], item);
        localCompletions.push(item);
      }
    }
  }

  // Collect general buffer words with line numbers for proximity-weighted recall
  const wordRegex = /\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g;
  const maxLines = Math.min(lines.length, 900);
  for (let i = 0; i < maxLines; i++) {
    const ln = lines[i];
    if (ln.trimStart().startsWith('#') || ln.trimStart().startsWith('//')) continue;
    let wm: RegExpExecArray | null;
    while ((wm = wordRegex.exec(ln)) !== null) {
      const w = wm[0];
      if (!seenTopLabels.has(w)) {
        identifierLines.set(w, i + 1);
        if (identifierLines.size >= 260) break;
      }
    }
    if (identifierLines.size >= 260) break;
  }

  return {
    aliases,
    localCompletions,
    localSignatures,
    classMembers,
    lineToClass: (lineNo: number) => {
      for (let i = classSpans.length - 1; i >= 0; i--) {
        const sp = classSpans[i];
        if (lineNo >= sp.startLine && lineNo <= sp.endLine) {
          return sp.name;
        }
      }
      return null;
    },
    lineToFunction: (lineNo: number) => {
      for (let i = fnSpans.length - 1; i >= 0; i--) {
        const fn = fnSpans[i];
        if (lineNo >= fn.startLine && lineNo <= fn.endLine) {
          return fn;
        }
      }
      return null;
    },
    scopedVarLines,
    identifierLines,
    identifiers: new Set(identifierLines.keys()),
  };
}

// ============================================================================
// 4. Context-Aware Relevance Ranking & Completion Source Factory
// ============================================================================

const PYTHON_STATEMENT_ONLY_KEYWORDS = new Set([
  'import',
  'from',
  'def',
  'adef',
  'class',
  'nnmod',
  'ifmain',
  'withopen',
  'fore',
  'try',
  'except',
  'finally',
  'elif',
  'while',
  'with',
  'raise',
  'return',
  'yield',
  'pass',
  'break',
  'continue',
  'del',
  'global',
  'nonlocal',
  'assert',
  'match',
  'case',
]);

const PYTHON_CORE_BUILTINS = new Set([
  'print',
  'range',
  'len',
  'enumerate',
  'isinstance',
  'open',
  'zip',
  'sum',
  'min',
  'max',
  'abs',
  'round',
  'sorted',
  'super',
  'int',
  'float',
  'str',
  'list',
  'dict',
  'set',
  'tuple',
  'bool',
  'ValueError',
  'RuntimeError',
  'Exception',
]);

function isInsideCommentOrString(state: EditorState, pos: number, language: string): boolean {
  if (language === 'markdown' || language === 'text' || language === 'batch') {
    return false;
  }
  try {
    const node = syntaxTree(state).resolveInner(pos, -1);
    const name = node.name.toLowerCase();
    if (name.includes('comment')) return true;
    if (language !== 'json' && (name.includes('string') || name.includes('regexp'))) {
      return true;
    }
  } catch {
    // Ignore syntax tree lookup edge cases
  }
  return false;
}

/**
 * Suppresses automatic completion popups when the user is inventing/declaring a new identifier
 * (e.g. `def my_func`, `def f(x, bias`, `import numpy as np`, `for idx`) so pressing Enter or Tab
 * never hijacks their newly typed variable/function name with an unrelated builtin!
 */
function isDeclarationPosition(beforeLine: string, language: string): boolean {
  if (language === 'python') {
    // Naming a new function or class: `def foo|` or `class Bar|`
    if (/^\s*(?:async\s+)?def\s+[A-Za-z_][\w]*$/.test(beforeLine)) return true;
    if (/^\s*class\s+[A-Za-z_][\w]*$/.test(beforeLine)) return true;

    // Naming alias after `as`: `import numpy as np|`, `except Exception as e|`, `with open(...) as f|`
    if (/\bas\s+[A-Za-z_][\w]*$/.test(beforeLine)) return true;

    // Naming loop target variable before `in`: `for i, item|`
    if (/^\s*(?:async\s+)?for\s+[A-Za-z_,\s]*$/.test(beforeLine) && !/\bin\b/.test(beforeLine)) {
      return true;
    }

    // Inside `def func(param1, param2|)` parameter list (unless typing `: Type` or `= default`)
    const defParamHeader = /^\s*(?:async\s+)?def\s+[A-Za-z_][\w]*\s*\(([^)]*)$/.exec(beforeLine);
    if (defParamHeader) {
      const paramListTail = defParamHeader[1];
      const lastSeg = paramListTail.split(',').pop() || '';
      if (!lastSeg.includes(':') && !lastSeg.includes('=')) {
        return true;
      }
    }
    return false;
  }

  if (language === 'javascript' || language === 'typescript' || language === 'rust') {
    if (
      /^\s*(?:export\s+)?(?:default\s+)?(?:pub\s+)?(?:async\s+)?(?:function|class|const|let|var|fn|struct|enum|interface|type)\s+[A-Za-z_$][\w$]*$/.test(
        beforeLine
      )
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Tiered VS Code-style string matcher:
 * Exact > Case-sensitive Prefix > Case-insensitive Prefix > Word-boundary (`_bias`) > Acronym > Substring (len>=2) > Tight Subsequence (len>=3).
 * Rejects loose noisy matches (such as 1-letter mid-word hits that previously flooded Python builtins).
 */
function matchAndScoreLabel(
  label: string,
  query: string
): { matchScore: number; ranges: number[] } | null {
  if (!query) {
    return { matchScore: 0, ranges: [] };
  }

  if (label === query) {
    return { matchScore: 12000, ranges: [0, label.length] };
  }

  const labelLower = label.toLowerCase();
  const qLower = query.toLowerCase();

  if (labelLower === qLower) {
    return { matchScore: 11000, ranges: [0, label.length] };
  }

  if (label.startsWith(query)) {
    return { matchScore: 9200, ranges: [0, query.length] };
  }

  if (labelLower.startsWith(qLower)) {
    return { matchScore: 8000, ranges: [0, query.length] };
  }

  // Check snake_case / hyphen / CamelCase word boundary prefix (e.g. "bias" in "add_bias")
  for (let i = 1; i < label.length; i++) {
    const prev = label[i - 1];
    const cur = label[i];
    const isBoundary =
      prev === '_' ||
      prev === '-' ||
      prev === '.' ||
      (prev >= 'a' && prev <= 'z' && cur >= 'A' && cur <= 'Z');
    if (isBoundary && labelLower.slice(i).startsWith(qLower)) {
      return { matchScore: 6400 - i * 6, ranges: [i, i + query.length] };
    }
  }

  // For a single typed character, ONLY allow prefix or word-boundary matches!
  if (query.length === 1) {
    return null;
  }

  // Multi-segment boundary acronym match (e.g. "ab" -> "add_bias", "ml" -> "mse_loss")
  {
    const boundaryIndices: number[] = [0];
    for (let i = 1; i < label.length; i++) {
      const prev = label[i - 1];
      const cur = label[i];
      if (
        prev === '_' ||
        prev === '-' ||
        (prev >= 'a' && prev <= 'z' && cur >= 'A' && cur <= 'Z')
      ) {
        boundaryIndices.push(i);
      }
    }
    if (query.length <= boundaryIndices.length) {
      let bPos = 0;
      const ranges: number[] = [];
      let allMatched = true;
      for (let qi = 0; qi < qLower.length; qi++) {
        let found = false;
        while (bPos < boundaryIndices.length) {
          const idx = boundaryIndices[bPos++];
          if (labelLower[idx] === qLower[qi]) {
            ranges.push(idx, idx + 1);
            found = true;
            break;
          }
        }
        if (!found) {
          allMatched = false;
          break;
        }
      }
      if (allMatched) {
        return { matchScore: 5600, ranges };
      }
    }
  }

  // Contiguous substring match (`query.length >= 2`, e.g. "space" -> "linspace")
  const subIdx = labelLower.indexOf(qLower);
  if (subIdx > 0) {
    return {
      matchScore: 4200 - subIdx * 14,
      ranges: [subIdx, subIdx + query.length],
    };
  }

  // Tight subsequence match (`query.length >= 3` only, avoiding stretched accidental matches)
  if (query.length >= 3) {
    const ranges: number[] = [];
    let searchFrom = 0;
    let firstIdx = -1;
    let lastIdx = -1;
    for (let qi = 0; qi < qLower.length; qi++) {
      const idx = labelLower.indexOf(qLower[qi], searchFrom);
      if (idx === -1) return null;
      if (firstIdx === -1) firstIdx = idx;
      lastIdx = idx;
      ranges.push(idx, idx + 1);
      searchFrom = idx + 1;
    }
    const span = lastIdx - firstIdx + 1;
    if (span <= query.length * 2 + 2) {
      return { matchScore: 2200 - span * 18, ranges };
    }
  }

  return null;
}

interface RankingContext {
  language: string;
  cursorLine: number;
  indent: number;
  beforeWord: string;
  isInsideFunction: boolean;
  enclosingFnName?: string;
  isMemberMode: boolean;
}

function proximityBonus(defLine: number | undefined, cursorLine: number): number {
  if (!defLine || defLine === cursorLine) return 0;
  const dist = Math.abs(cursorLine - defLine);
  if (dist <= 3) return 190;
  if (dist <= 10) return 150;
  if (dist <= 25) return 100;
  if (dist <= 60) return 50;
  return 15;
}

function rankAndBuildResult(
  from: number,
  query: string,
  candidates: RankedCompletion[],
  ctx: RankingContext
): CompletionResult | null {
  const trimmedBefore = ctx.beforeWord.trim();
  const isStatementStart =
    !ctx.isMemberMode && (trimmedBefore === '' || /[:;]\s*$/.test(trimmedBefore));
  const isAfterForTarget =
    ctx.language === 'python' &&
    /^\s*(?:async\s+)?for\s+[A-Za-z_][\w\s,]*\s+$/.test(ctx.beforeWord) &&
    !/\bin\b/.test(ctx.beforeWord);
  const isAfterInKeyword =
    ctx.language === 'python' && /\bfor\s+[\w\s,]+\s+in\s+$/.test(ctx.beforeWord);
  const isPureValueExpr =
    !ctx.isMemberMode &&
    !isStatementStart &&
    /(?:[=+\-*/%([,{]|==|!=|<=|>=|<|>|\b(?:return|yield|in|and|or|not|if|elif|while|assert)\s)\s*$/.test(
      ctx.beforeWord
    );

  const scored: { comp: Completion; total: number; ranges: number[] }[] = [];
  const bestByLabel = new Map<string, number>();

  for (const raw of candidates) {
    const label = raw.label;

    // Filter out statement-only keywords/snippets inside value expressions like `print(|)` or `res = |`
    if (
      ctx.language === 'python' &&
      isPureValueExpr &&
      PYTHON_STATEMENT_ONLY_KEYWORDS.has(label)
    ) {
      continue;
    }

    // Outside a `def` function, `return` and `yield` are invalid in Python
    if (
      ctx.language === 'python' &&
      !ctx.isInsideFunction &&
      (label === 'return' || label === 'yield')
    ) {
      continue;
    }

    const m = matchAndScoreLabel(label, query);
    if (!m) continue;

    let ctxScore = raw.boost ?? 0;
    const origin = raw._origin;

    if (ctx.isMemberMode) {
      if (origin === 'self-member') {
        ctxScore += 920 + (raw.boost ?? 0) * 6;
        if (ctx.enclosingFnName && label === ctx.enclosingFnName) {
          ctxScore -= 120;
        }
      } else {
        ctxScore += 400 + (raw.boost ?? 0) * 6;
      }
    } else {
      switch (origin) {
        case 'enclosing-param':
          ctxScore += 980;
          break;
        case 'enclosing-local':
          ctxScore += 910 + proximityBonus(raw._defLine, ctx.cursorLine);
          break;
        case 'imported-symbol':
          ctxScore += 850 + proximityBonus(raw._defLine, ctx.cursorLine);
          break;
        case 'file-var':
          ctxScore += 830 + proximityBonus(raw._defLine, ctx.cursorLine);
          break;
        case 'file-fn':
        case 'file-class':
          ctxScore += 790 + proximityBonus(raw._defLine, ctx.cursorLine);
          break;
        case 'sibling-module':
          ctxScore += 660;
          break;
        case 'snippet':
          ctxScore += isStatementStart ? 710 : 220;
          break;
        case 'stmt-keyword':
          if (isStatementStart) {
            if ((label === 'return' || label === 'yield') && ctx.isInsideFunction) {
              ctxScore += 880;
            } else if (ctx.indent === 0 && (label === 'import' || label === 'from' || label === 'def' || label === 'class')) {
              ctxScore += 780;
            } else {
              ctxScore += 700;
            }
          } else {
            ctxScore += 200;
          }
          break;
        case 'expr-keyword':
          if (isAfterForTarget && label === 'in') {
            ctxScore += 1500;
          } else if (isPureValueExpr && (label === 'True' || label === 'False' || label === 'None')) {
            ctxScore += 540;
          } else {
            ctxScore += 360;
          }
          break;
        case 'builtin-core':
          if (isStatementStart && label === 'print') {
            ctxScore += 740;
          } else if (isAfterInKeyword && (label === 'range' || label === 'enumerate' || label === 'zip')) {
            ctxScore += 820;
          } else {
            ctxScore += 360;
          }
          break;
        case 'builtin-rare':
          ctxScore += 140;
          break;
        case 'buffer-word':
          ctxScore += 280 + proximityBonus(raw._defLine, ctx.cursorLine);
          break;
        default:
          ctxScore += 300;
          break;
      }
    }

    // Slight preference for concise canonical names on ties
    const lengthPenalty = Math.min(label.length, 28) * 3;
    const total = m.matchScore + ctxScore - lengthPenalty;

    // Strip `section` completely so CodeMirror NEVER re-groups alphabetically by section name!
    const cleanComp: Completion = {
      label: raw.label,
      displayLabel: raw.displayLabel,
      detail: raw.detail,
      info: raw.info,
      apply: raw.apply,
      type: raw.type,
    };

    const existingIdx = bestByLabel.get(label);
    if (existingIdx !== undefined) {
      if (total > scored[existingIdx].total) {
        scored[existingIdx] = { comp: cleanComp, total, ranges: m.ranges };
      }
    } else {
      bestByLabel.set(label, scored.length);
      scored.push({ comp: cleanComp, total, ranges: m.ranges });
    }
  }

  if (scored.length === 0) return null;

  scored.sort((a, b) => b.total - a.total || a.comp.label.localeCompare(b.comp.label));
  const topSlice = scored.slice(0, 80);
  const rangeLookup = new WeakMap<Completion, number[]>();
  const finalOptions: Completion[] = [];

  for (const item of topSlice) {
    rangeLookup.set(item.comp, item.ranges);
    finalOptions.push(item.comp);
  }

  return {
    from,
    options: finalOptions,
    filter: false,
    getMatch: (c) => rangeLookup.get(c) || [],
  };
}

function resolveMemberCompletions(
  receiverRaw: string,
  language: string,
  cursorLine: number,
  analyzed: AnalyzedDocument,
  extCtx: IntelliSenseExternalContext
): RankedCompletion[] {
  if (language === 'python') {
    if (receiverRaw === 'self') {
      const clsName = analyzed.lineToClass(cursorLine);
      if (clsName) {
        const clsInfo = analyzed.classMembers.get(clsName);
        if (clsInfo) {
          const list: RankedCompletion[] = [...clsInfo.completions];
          if (clsInfo.inheritsNnModule) {
            for (const m of NN_MODULE_SELF_METHODS) {
              list.push(toCompletion(m, 'nn.Module', 'member'));
            }
          }
          return list;
        }
      }
      return NN_MODULE_SELF_METHODS.map((m) => toCompletion(m, 'nn.Module', 'member'));
    }

    const parts = receiverRaw.split('.');
    const headResolved = analyzed.aliases.get(parts[0]) || parts[0];
    const resolvedFull = [headResolved, ...parts.slice(1)].join('.');

    const merged = new Map<string, RankedCompletion>();

    const sibling = extCtx.siblingModules.find(
      (m) => m.moduleName === resolvedFull || m.moduleName === parts[0]
    );
    if (sibling) {
      for (const sym of sibling.symbols) {
        merged.set(sym.label, externalItemToCompletion(sym, sibling.moduleName, 45));
      }
    }

    const curated = PYTHON_MODULE_CATALOG[resolvedFull];
    if (curated) {
      for (const entry of curated) {
        if (!merged.has(entry.label)) {
          merged.set(entry.label, toCompletion(entry, resolvedFull, 'member'));
        }
      }
    }

    const runtimeSyms =
      extCtx.runtimePythonModules[resolvedFull] ||
      extCtx.runtimePythonModules[receiverRaw];
    if (runtimeSyms) {
      for (const sym of runtimeSyms) {
        if (!merged.has(sym.label)) {
          merged.set(sym.label, externalItemToCompletion(sym, resolvedFull, 24));
        }
      }
    }

    const localCls = analyzed.classMembers.get(receiverRaw);
    if (localCls) {
      for (const c of localCls.completions) {
        if (!merged.has(c.label)) merged.set(c.label, c);
      }
    }

    if (merged.size > 0) {
      return Array.from(merged.values());
    }

    return GENERIC_PYTHON_OBJECT_MEMBERS.map((m) => toCompletion(m, '属性/方法', 'member'));
  }

  if (language === 'javascript' || language === 'typescript') {
    const known = JS_TS_RECEIVERS[receiverRaw];
    if (known) {
      return known.map((e) => toCompletion(e, receiverRaw, 'member'));
    }
    return JS_GENERIC_MEMBERS.map((e) => toCompletion(e, '属性/方法', 'member'));
  }

  if (language === 'rust') {
    return RUST_DOT_MEMBERS.map((e) => toCompletion(e, 'Rust', 'member'));
  }

  return [];
}

export function buildLanguageCompletionSource(
  language: string,
  getExternalContext: () => IntelliSenseExternalContext
): CompletionSource {
  let cachedDocText = '';
  let cachedLang = '';
  let cachedAnalysis: AnalyzedDocument | null = null;

  const getAnalysis = (docText: string): AnalyzedDocument => {
    if (cachedAnalysis && cachedDocText === docText && cachedLang === language) {
      return cachedAnalysis;
    }
    cachedDocText = docText;
    cachedLang = language;
    cachedAnalysis = analyzeDocumentForCompletions(docText, language);
    return cachedAnalysis;
  };

  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const beforeLine = line.text.slice(0, context.pos - line.from);
    const indent = line.text.length - line.text.trimStart().length;

    if (!context.explicit && isInsideCommentOrString(context.state, context.pos, language)) {
      return null;
    }

    if (!context.explicit && isDeclarationPosition(beforeLine, language)) {
      return null;
    }

    const docText = context.state.doc.toString();
    const analyzed = getAnalysis(docText);
    const extCtx = getExternalContext();
    const enclosingFn = analyzed.lineToFunction(line.number);

    // ---- Case 1: Python `from <mod> import <sym>` or `import <mod>` ----
    if (language === 'python') {
      const fromImportMatch = /^\s*from\s+([A-Za-z_][\w.]*)\s+import\s+(?:[\w\s,]*,\s*)?([A-Za-z_][\w]*)?$/.exec(
        beforeLine
      );
      if (fromImportMatch) {
        const modName = fromImportMatch[1];
        const partial = fromImportMatch[2] || '';
        const options = resolveMemberCompletions(
          modName,
          'python',
          line.number,
          analyzed,
          extCtx
        );
        return rankAndBuildResult(context.pos - partial.length, partial, options, {
          language,
          cursorLine: line.number,
          indent,
          beforeWord: beforeLine.slice(0, beforeLine.length - partial.length),
          isInsideFunction: Boolean(enclosingFn),
          isMemberMode: true,
        });
      }

      const importModMatch = /^\s*(import|from)\s+([A-Za-z_][\w.]*)?$/.exec(beforeLine);
      if (importModMatch) {
        const kw = importModMatch[1];
        const partial = importModMatch[2] || '';
        const modOptions: RankedCompletion[] = [
          ...extCtx.siblingModules.map((m) => ({
            label: m.moduleName,
            type: 'namespace',
            detail: '工作区本地模块',
            boost: 50,
            _origin: 'sibling-module' as const,
          })),
          ...PYTHON_COMMON_MODULES.map((m) => toCompletion(m, undefined, 'member')),
        ];
        if (kw === 'import') {
          modOptions.push(
            { label: 'numpy as np', type: 'namespace', detail: '科学计算常用简写', boost: 34, _origin: 'member' },
            { label: 'matplotlib.pyplot as plt', type: 'namespace', detail: '绘图常用简写', boost: 30, _origin: 'member' },
            { label: 'pandas as pd', type: 'namespace', detail: '表格分析常用简写', boost: 28, _origin: 'member' },
            { label: 'torch.nn as nn', type: 'namespace', detail: '神经网络层常用简写', boost: 31, _origin: 'member' },
            { label: 'torch.nn.functional as F', type: 'namespace', detail: '算子函数常用简写', boost: 30, _origin: 'member' }
          );
        }
        return rankAndBuildResult(context.pos - partial.length, partial, modOptions, {
          language,
          cursorLine: line.number,
          indent,
          beforeWord: beforeLine.slice(0, beforeLine.length - partial.length),
          isInsideFunction: Boolean(enclosingFn),
          isMemberMode: true,
        });
      }
    }

    // ---- Case 2: Dot-member completion (`np.`, `torch.nn.`, `self.`, `console.`, etc.) ----
    const dotMatch = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.([A-Za-z_$][\w$]*)?$/.exec(
      beforeLine
    );
    if (dotMatch) {
      const receiver = dotMatch[1];
      const memberPrefix = dotMatch[2] || '';
      if (!/^\d+$/.test(receiver)) {
        const memberOptions = resolveMemberCompletions(
          receiver,
          language,
          line.number,
          analyzed,
          extCtx
        );
        if (memberOptions.length > 0) {
          return rankAndBuildResult(
            context.pos - memberPrefix.length,
            memberPrefix,
            memberOptions,
            {
              language,
              cursorLine: line.number,
              indent,
              beforeWord: beforeLine.slice(0, beforeLine.length - memberPrefix.length),
              isInsideFunction: Boolean(enclosingFn),
              enclosingFnName: enclosingFn?.name,
              isMemberMode: true,
            }
          );
        }
      }
    }

    // ---- Case 3: Standard identifier / keyword / snippet completion ----
    const wordMatch =
      language === 'powershell'
        ? /[\$A-Za-z_][\w-]*$/.exec(beforeLine)
        : /[A-Za-z_$@][\w$!]*$/.exec(beforeLine);

    if (!wordMatch && !context.explicit) {
      return null;
    }

    const from = wordMatch ? context.pos - wordMatch[0].length : context.pos;
    const currentWord = wordMatch ? wordMatch[0] : '';
    const beforeWord = beforeLine.slice(0, beforeLine.length - currentWord.length);
    const nextChar = context.state.doc.sliceString(context.pos, context.pos + 1);

    const options: RankedCompletion[] = [...analyzed.localCompletions];

    // Enclosing function parameters & local variables get highest contextual priority!
    if (enclosingFn) {
      for (const pName of enclosingFn.params) {
        options.push({
          label: pName,
          type: 'variable',
          detail: `${enclosingFn.name} 参数`,
          boost: 55,
          _origin: 'enclosing-param',
          _defLine: enclosingFn.startLine,
        });
      }
      for (const [vName, defLine] of enclosingFn.localVars.entries()) {
        if (vName !== currentWord || defLine !== line.number) {
          options.push({
            label: vName,
            type: 'variable',
            detail: '局部变量',
            boost: 52,
            _origin: 'enclosing-local',
            _defLine: defLine,
          });
        }
      }
    }

    // Scoped variables defined in blocks like `if __name__ == "__main__":`
    for (const [vName, defLine] of analyzed.scopedVarLines.entries()) {
      if (vName !== currentWord || defLine !== line.number) {
        options.push({
          label: vName,
          type: 'variable',
          detail: '当前文件变量',
          boost: 50,
          _origin: 'enclosing-local',
          _defLine: defLine,
        });
      }
    }

    if (language === 'python') {
      if (analyzed.lineToClass(line.number)) {
        options.push({
          label: 'self',
          type: 'keyword',
          detail: '当前类实例',
          boost: 54,
          _origin: 'enclosing-param',
        });
      }

      for (const snip of PYTHON_SNIPPETS) {
        options.push({ ...snip, _origin: 'snippet' });
      }

      for (const b of PYTHON_BUILTINS) {
        options.push(
          toCompletion(
            b,
            '内置函数',
            PYTHON_CORE_BUILTINS.has(b.label) ? 'builtin-core' : 'builtin-rare'
          )
        );
      }

      for (const kw of PYTHON_KEYWORDS) {
        const isStmt = PYTHON_STATEMENT_ONLY_KEYWORDS.has(kw) || kw === 'if' || kw === 'for';
        const autoSpace =
          (kw === 'import' || kw === 'from' || kw === 'return') && nextChar !== ' '
            ? `${kw} `
            : undefined;
        options.push({
          label: kw,
          apply: autoSpace,
          type: 'keyword',
          detail: '关键字',
          boost: isStmt ? 30 : 22,
          _origin: isStmt ? 'stmt-keyword' : 'expr-keyword',
        });
      }

      for (const sib of extCtx.siblingModules) {
        options.push({
          label: sib.moduleName,
          type: 'namespace',
          detail: '工作区本地模块',
          boost: 35,
          _origin: 'sibling-module',
        });
      }
    } else if (language === 'javascript' || language === 'typescript') {
      for (const snip of JS_TS_SNIPPETS) {
        options.push({ ...snip, _origin: 'snippet' });
      }
      for (const g of JS_TS_GLOBALS) {
        options.push(toCompletion(g, '全局对象', 'builtin-core'));
      }
      for (const kw of [
        'const',
        'let',
        'function',
        'async',
        'await',
        'return',
        'if',
        'else',
        'for',
        'while',
        'switch',
        'case',
        'export',
        'import',
        'from',
        'class',
        'interface',
        'type',
        'true',
        'false',
        'null',
        'undefined',
      ]) {
        options.push({
          label: kw,
          type: 'keyword',
          detail: '关键字',
          boost: 25,
          _origin: 'stmt-keyword',
        });
      }
    } else if (language === 'rust') {
      for (const c of RUST_COMPLETIONS) {
        options.push({ ...c, _origin: 'builtin-core' });
      }
      for (const kw of [
        'let',
        'mut',
        'fn',
        'pub',
        'struct',
        'enum',
        'impl',
        'trait',
        'match',
        'if',
        'else',
        'for',
        'while',
        'loop',
        'return',
        'use',
        'mod',
        'async',
        'await',
      ]) {
        options.push({
          label: kw,
          type: 'keyword',
          detail: '关键字',
          boost: 25,
          _origin: 'stmt-keyword',
        });
      }
    } else if (language === 'powershell') {
      for (const c of POWERSHELL_COMPLETIONS) {
        options.push({ ...c, _origin: 'builtin-core' });
      }
    } else if (language === 'batch') {
      for (const c of BATCH_COMPLETIONS) {
        options.push({ ...c, _origin: 'builtin-core' });
      }
    } else if (language === 'sql') {
      for (const c of SQL_COMPLETIONS) {
        options.push({ ...c, _origin: 'stmt-keyword' });
      }
    } else if (language === 'markdown') {
      for (const c of MARKDOWN_COMPLETIONS) {
        options.push({ ...c, _origin: 'snippet' });
      }
    }

    for (const [id, seenLine] of analyzed.identifierLines.entries()) {
      if (id !== currentWord) {
        options.push({
          label: id,
          type: 'variable',
          boost: 12,
          _origin: 'buffer-word',
          _defLine: seenLine,
        });
      }
    }

    return rankAndBuildResult(from, currentWord, options, {
      language,
      cursorLine: line.number,
      indent,
      beforeWord,
      isInsideFunction: Boolean(enclosingFn),
      isMemberMode: false,
    });
  };
}

// ============================================================================
// 5. Floating Call-Signature Parameter Hint Tooltip (`func(arg1, |)`)
// ============================================================================

interface ActiveCallInfo {
  openParenPos: number;
  callee: string;
  paramIndex: number;
}

function findActiveFunctionCall(state: EditorState, pos: number): ActiveCallInfo | null {
  const startScan = Math.max(0, pos - 420);
  const slice = state.doc.sliceString(startScan, pos);

  // Quick bail if cursor itself appears to be inside an unclosed single-line string literal
  const line = state.doc.lineAt(pos);
  const linePrefix = line.text.slice(0, pos - line.from);
  let singleQuotes = 0;
  let doubleQuotes = 0;
  for (let i = 0; i < linePrefix.length; i++) {
    const ch = linePrefix[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === "'" && doubleQuotes % 2 === 0) singleQuotes += 1;
    else if (ch === '"' && singleQuotes % 2 === 0) doubleQuotes += 1;
    else if (ch === '#' && singleQuotes % 2 === 0 && doubleQuotes % 2 === 0) return null;
  }
  if (singleQuotes % 2 === 1 || doubleQuotes % 2 === 1) return null;

  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let commasAtTarget = 0;
  let inQuote: string | null = null;

  for (let i = slice.length - 1; i >= 0; i--) {
    const ch = slice[i];
    if (inQuote) {
      if (ch === inQuote && slice[i - 1] !== '\\') {
        inQuote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    if (ch === ')') parenDepth += 1;
    else if (ch === ']') bracketDepth += 1;
    else if (ch === '}') braceDepth += 1;
    else if (ch === '[') {
      if (bracketDepth > 0) bracketDepth -= 1;
      else if (parenDepth === 0 && braceDepth === 0) commasAtTarget = 0;
    } else if (ch === '{') {
      if (braceDepth > 0) braceDepth -= 1;
      else if (parenDepth === 0 && bracketDepth === 0) commasAtTarget = 0;
    } else if (ch === ',' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      commasAtTarget += 1;
    } else if (ch === '(') {
      if (parenDepth > 0) {
        parenDepth -= 1;
      } else {
        const beforeParen = slice.slice(0, i);
        const calleeMatch = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*$/.exec(beforeParen);
        if (!calleeMatch) return null;
        const callee = calleeMatch[1];
        // Skip control-flow keywords like `if (...)` / `for (...)` / `while (...)`
        if (
          callee === 'if' ||
          callee === 'elif' ||
          callee === 'for' ||
          callee === 'while' ||
          callee === 'switch' ||
          callee === 'catch' ||
          callee === 'def' ||
          callee === 'function' ||
          callee === 'fn' ||
          callee === 'class'
        ) {
          return null;
        }
        return {
          openParenPos: startScan + i,
          callee,
          paramIndex: commasAtTarget,
        };
      }
    }
  }
  return null;
}

function lookupSignatureRecord(
  callee: string,
  cursorLine: number,
  language: string,
  analyzed: AnalyzedDocument,
  extCtx: IntelliSenseExternalContext
): SignatureRecord | null {
  // 1. Direct local function or imported symbol signature
  const direct = analyzed.localSignatures.get(callee);
  if (direct) return direct;

  if (language === 'python') {
    // Builtin functions
    const builtin = PYTHON_BUILTINS.find((b) => b.label === callee && b.detail?.startsWith('('));
    if (builtin && builtin.detail) {
      return { label: callee, params: builtin.detail, doc: builtin.doc };
    }

    // Dot-call: `self.method(...)` or `np.linspace(...)` or `core.solve(...)`
    const dotIdx = callee.lastIndexOf('.');
    if (dotIdx > 0) {
      const recv = callee.slice(0, dotIdx);
      const member = callee.slice(dotIdx + 1);

      if (recv === 'self') {
        const clsName = analyzed.lineToClass(cursorLine);
        if (clsName) {
          const sig = analyzed.classMembers.get(clsName)?.signatures.get(member);
          if (sig) return sig;
        }
      }

      const recvParts = recv.split('.');
      const resolvedRecv = [analyzed.aliases.get(recvParts[0]) || recvParts[0], ...recvParts.slice(1)].join('.');
      const modCatalog = PYTHON_MODULE_CATALOG[resolvedRecv];
      const modEntry = modCatalog?.find((e) => e.label === member && e.detail?.startsWith('('));
      if (modEntry && modEntry.detail) {
        return { label: `${recv}.${member}`, params: modEntry.detail, doc: modEntry.doc };
      }

      const sib = extCtx.siblingModules.find(
        (m) => m.moduleName === resolvedRecv || m.moduleName === recv
      );
      const sibSym = sib?.symbols.find((s) => s.label === member && s.detail?.startsWith('('));
      if (sibSym && sibSym.detail) {
        return { label: `${recv}.${member}`, params: sibSym.detail, doc: sibSym.doc ?? undefined };
      }

      const rtSyms = extCtx.runtimePythonModules[resolvedRecv] || extCtx.runtimePythonModules[recv];
      const rtSym = rtSyms?.find((s) => s.label === member && s.detail?.startsWith('('));
      if (rtSym && rtSym.detail) {
        return {
          label: `${recv}.${member}`,
          params: rtSym.detail.replace(/^\(\s*self\s*,?\s*/, '('),
          doc: rtSym.doc ?? undefined,
        };
      }
    }
  } else if (language === 'javascript' || language === 'typescript') {
    const dotIdx = callee.lastIndexOf('.');
    if (dotIdx > 0) {
      const recv = callee.slice(0, dotIdx);
      const member = callee.slice(dotIdx + 1);
      const entry = JS_TS_RECEIVERS[recv]?.find((e) => e.label === member && e.detail?.startsWith('('));
      if (entry && entry.detail) {
        return { label: callee, params: entry.detail, doc: entry.doc };
      }
    }
  }

  return null;
}

function splitTopLevelParams(paramSig: string): { inner: string[]; suffix: string } {
  const closeIdx = paramSig.lastIndexOf(')');
  if (!paramSig.startsWith('(') || closeIdx < 0) {
    return { inner: [paramSig], suffix: '' };
  }
  const body = paramSig.slice(1, closeIdx);
  const suffix = paramSig.slice(closeIdx + 1).trim();
  if (!body.trim()) return { inner: [], suffix };

  const parts: string[] = [];
  let cur = '';
  let depth = 0;
  for (const ch of body) {
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return { inner: parts, suffix };
}

function createSignatureHelpExtension(
  language: string,
  getExternalContext: () => IntelliSenseExternalContext
): Extension {
  return StateField.define<Tooltip | null>({
    create: () => null,
    update(prev, tr) {
      if (!tr.docChanged && !tr.selection) return prev;
      const state = tr.state;
      if (!state.selection.main.empty) return null;
      const pos = state.selection.main.head;
      const callInfo = findActiveFunctionCall(state, pos);
      if (!callInfo) return null;

      const analyzed = analyzeDocumentForCompletions(state.doc.toString(), language);
      const lineNo = state.doc.lineAt(pos).number;
      const sig = lookupSignatureRecord(
        callInfo.callee,
        lineNo,
        language,
        analyzed,
        getExternalContext()
      );
      if (!sig) return null;

      const { inner, suffix } = splitTopLevelParams(sig.params);
      const activeIdx =
        inner.length > 0 ? Math.min(callInfo.paramIndex, inner.length - 1) : -1;

      return {
        pos: callInfo.openParenPos,
        above: true,
        strictSide: false,
        arrow: false,
        create() {
          const dom = document.createElement('div');
          dom.className = 'dp-signature-tooltip';

          const header = document.createElement('div');
          header.className = 'dp-signature-line';

          const fnSpan = document.createElement('span');
          fnSpan.className = 'dp-sig-fn';
          fnSpan.textContent = `${sig.label}(`;
          header.appendChild(fnSpan);

          inner.forEach((p, idx) => {
            if (idx > 0) {
              header.appendChild(document.createTextNode(', '));
            }
            const pSpan = document.createElement('span');
            pSpan.className = idx === activeIdx ? 'dp-sig-param-active' : 'dp-sig-param';
            pSpan.textContent = p;
            header.appendChild(pSpan);
          });

          const tail = document.createElement('span');
          tail.className = 'dp-sig-fn';
          tail.textContent = suffix ? `) ${suffix}` : ')';
          header.appendChild(tail);
          dom.appendChild(header);

          if (sig.doc) {
            const docEl = document.createElement('div');
            docEl.className = 'dp-signature-doc';
            docEl.textContent = sig.doc;
            dom.appendChild(docEl);
          }

          return { dom };
        },
      };
    },
    provide: (f) => showTooltip.from(f),
  });
}

// ============================================================================
// 6. Public CodeMirror 6 IntelliSense Bundle
// ============================================================================

export function createIntelliSenseExtensions(
  language: string,
  getExternalContext: () => IntelliSenseExternalContext
): Extension[] {
  if (language === 'text') {
    return [];
  }

  const source = buildLanguageCompletionSource(language, getExternalContext);

  // Highest-priority keymap so Tab accepts active popup items or jumps snippet fields,
  // while Alt+/ and Ctrl+Space manually trigger completions even under Windows Chinese IMEs!
  const vsCodeCompletionKeymap = Prec.highest(
    keymap.of([
      {
        key: 'Tab',
        run: (view) => {
          if (completionStatus(view.state) === 'active') {
            return acceptCompletion(view);
          }
          if (hasNextSnippetField(view.state)) {
            return nextSnippetField(view);
          }
          return false;
        },
      },
      {
        key: 'Shift-Tab',
        run: (view) => {
          if (hasPrevSnippetField(view.state)) {
            return prevSnippetField(view);
          }
          return false;
        },
      },
      {
        key: 'Alt-/',
        run: startCompletion,
      },
      {
        key: 'Mod-Space',
        run: startCompletion,
      },
      {
        key: 'Ctrl-j',
        run: startCompletion,
      },
    ])
  );

  return [
    vsCodeCompletionKeymap,
    autocompletion({
      activateOnTyping: true,
      activateOnTypingDelay: 18,
      interactionDelay: 20,
      activateOnCompletion: (c) => c.label === 'import' || c.label === 'from',
      selectOnOpen: true,
      maxRenderedOptions: 60,
      icons: true,
      override: [source],
    }),
    createSignatureHelpExtension(language, getExternalContext),
  ];
}
