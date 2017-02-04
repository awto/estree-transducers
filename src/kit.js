import * as R from "ramda"
import * as assert from "assert"
import {produce,consume,Tag,enter,resetFieldInfo,
        leave,tok,symbol,symInfo,typeInfo
       } from "./core"
import * as T from "babel-types"
import {parse} from "babylon"

const BROWSER_DEBUG = typeof window !== "undefined" && window.chrome
let _opts = {}

export function optsScope(fun) {
  const save = _opts
  try {
    return fun()
  } finally {
    _opts = save
  }
}

export function optsScopeLift(fun) {
  return function() {
    const save = _opts
    try {
      return fun.apply(this,arguments)
    } finally {
      _opts = save
    }
  }
}

export function setOpts(opts) {
  _opts = opts
}

/**
 * adds `take` function to ES6 iterators interface
 * children classes may implement one of `take` or `next` methods
 */
export class ExtIterator {
  [Symbol.iterator]() { return this }
  /**
   * ES6 Iterator interface `next`
   */
  next(v) {
    const c = this.take(v)
    return {value:c,done:c == null}
  }
  /**
   * same as `next` but returns either next value or null if done
   */
  take(v) {
    const c = this.next(v)
    return c.done ? null : c.value
  }
  constructor(cont) {
    this._cont = cont
  }
}

export class ArrayLookahead extends ExtIterator {
  constructor(cont) {
    super(cont)
    assert.ok(cont.length > 0,"input iterator should be not-empty")
    this._x = 0
    this.first = cont[0]
    this.opts = this.first.value && this.first.value.opts || _opts
  }
  next(v) {
    const c = this._cont[this._x++]
    if (c != null && c.value != null && c.value.opts != null)
      this.opts = c.value.opts
    return {value:c,done:c == null}
  }
  take(v) {
    const c = this._cont[this._x++]
    if (c != null && c.opts != null)
      this.opts = c.opts
    return c
  }
//  last() {
//    return this._cont[this._x-1]
//  }
  cur() {
    return this._cont[this._x]
  }
}

/** 
 * iterators wrapper keeping a single element lookahead, which may be accessed
 * with `cur` method
 *
 * the iterator may be shared
 */
export class Lookahead extends ExtIterator {
  constructor(cont) {
    super(cont)
    this._inner = cont[Symbol.iterator]()
    let i = this._inner.next()
    assert.ok(!i.done,"input iterator should be not-empty")
    this.first = i.value
    this.opts = this.first.value && this.first.value.opts || _opts
    this._cur = i
//    this._last = null
  }
  next(v) {
    const cur = this._cur
//    this._last = cur.value
    if (!cur.done) {
      if (cur.value.value != null && cur.value.value.opts != null)
        this.opts = cur.value.value.opts
      this._cur = this._inner.next(v)
    }
    return cur
  }
//  last() { return this._last; }
  take(v) {
    const cur = /*this._last =*/ this._cur
    if (cur.done)
      return null
    if (cur.value.opts != null)
      this.opts = cur.value.opts
    this._cur = this._inner.next(v)
    return cur.value
  }
  cur() { return this._cur.done ? undefined : this._cur.value }
}

const ctrlTok = Symbol("ctrlTok")
const ctrlTokGen = Symbol("ctrlTokGen")
const storedTok = Symbol("storedTok")

export const Output = (Super) => class Output extends Super {
  constructor(cont) {
    super(cont)
    this._stack = []
  }
  valCtor (pos,type,value) {
    let node = null
    if (value == null) { 
      value = {}
      if (type != null && typeof type !== "symbol") {
        if (type.node != null) {
          value = type
          node = value.node
          type = null
        } else if (type.type != null) {
          node = type
          value = {node}
          type = null
        }
      }
    } else
      node = value.node
    if (type == null) {
      if (value != null && value.typeInfo != null) {
        type = value.typeInfo.sym
      } else if (node != null && node.type != null) {
        type = Tag[node.type]
      } else {
        if (symInfo(pos) === "ctrl")
          type = pos
      }
    }
    assert.ok(type,"couldn't guess type")
    if (node == null) {
      value.node = node =
        type === Tag.Array ? [] : type === Tag.Null ? null : {}
    }
    if (!value.opts)
      value.opts = this.opts
//    value.typeInfo = symInfo(type)
    return [pos,type,value]
  }
  *toks(pos,node) {
    yield* toks(pos,node)
  }
  enter(pos,type,value) {
    [pos,type,value] = this.valCtor(pos,type,value)
    this._stack.unshift({$:storedTok,
                         tok:{enter:false,leave:true,
                              pos:pos,type:type,value:value}})
    return {enter:true,leave:false,type,pos,value}
  }
  tok(pos,type,value) {
    [pos,type,value] = this.valCtor(pos,type,value)
    return {enter:true,leave:true,type,pos,value}
  }
  *leave() {
    let f
    while((f=this._stack.shift())) {
      switch(f.$) {
      case ctrlTok:
        f.run(this)
        break
      case ctrlTokGen:
        yield* f.run(this)
        break
      default:
        yield f.tok
        return f.tok
      }
    }
  }
  label() {
    const pos = this._stack.length
    const t = this
    return function*() {
      const sub = t._stack.splice(0,t._stack.length - pos)
      for(const i of sub) {
        switch(i.$) {
        case ctrlTok:
          i.run(t)
          break
        case ctrlTokGen:
          yield* i.run(t)
          break
        default:
          yield i.tok
        }
      }
    }
  }
}

export function Level(Super) {
  function* one(t) {
    const c = t.cur()
    if (c == null || !c.enter)
      return null
    const exit = t.level
    let i
    for(i of t) {
      yield i
      if (exit >= t.level)
        return i
    }
    return i
  }
  function* sub(t) {
    const c = t.cur()
    if (c == null || !c.enter)
      return null
    const exit = t.level
    let i
    for(i of t) {
      yield i
      if (exit >= t.level) {
        const c = t.cur()
        if (c == null || !c.enter || exit > t.level)
          return i
      }
    }
    return i
  }
  return class Level extends Super {
    constructor(cont) {
      super(cont)
      this.level = 0
    }
    next(v) {
      const c = super.next(v)
      if (c.done)
        return c
      const t = c.value
      if (t.enter)
        this.level++
      if (t.leave)
        this.level--
      return c
    }
    take(v) {
      const c = super.take(v)
      if (c == null)
        return c
      if (c.enter)
        this.level++
      if (c.leave)
        this.level--
      return c
    }
    one() { return one(this) }
    sub() { return sub(this) }
    curLev() {
      const v = this.cur()
      if (!v || !v.enter)
        return null
      return v
    }
    *untilPos(pos) {
      var i
      while((i = this.curLev()) != null && i.pos !== pos)
        yield* one(this)
      return i
    }
    *findPos(pos) {
      const i = yield* this.untilPos(pos)
      if (i != null)
        this.take()
      return i
    }
    *toPos(pos) {
      const p = yield* this.findPos(pos)
      assert.ok(p)
      yield p
      return p
    }
  }
}

export function WithPeel(Super) {
  const copyTag = {$:ctrlTokGen,*run(t){yield t.take();},t:"copy"}
  // means we are to skip next tag from input because it is in the stack already
  const skipTag = {$:ctrlTok,run(t) { t.take(); },t:"skip"}
  // virtual close (already closed in token)
  const vCloseTag = {$:ctrlTok,run() {},t:"close"}
  return class WithPeel extends Super {
    constructor(cont) {
      super(cont)
    }
    peel(i) {
      if (i == null) 
        i = this.take()
      assert.ok(i.enter)
      const res = this.enter(i.pos,i.type,i.value)
      this._stack.unshift(i.leave ? vCloseTag : skipTag)
      return res
    }
    *peelTo(pos) {
      assert.notEqual(this._stack[0],vCloseTag)
      const i = yield *this.findPos(pos)
      assert.ok(i);
      yield this.peel(i);
      return i
    }
    peelOpt() {
      const v = this.cur()
      if (!v || !v.enter)
        return null
      return this.peel()
    }
    *one() {
      if (this._stack[0] !== vCloseTag)
        return (yield* super.one())
      return null
    }
    *sub() {
      if (this._stack[0] !== vCloseTag)
        return (yield* super.sub())
      return null
    }
    *findPos(pos) {
      if (this._stack[0] !== vCloseTag)
        return (yield* super.findPos(pos))
      return null
    }
    *copy(i) {
      yield this.peel(i);
      yield* this.sub();
      yield* this.leave();
    }
    close(i) {
      const j = this.take()
      assert.equal(i.value,j.value)
    }
  }
}

const memo = new Map()

export function* toks(pos,s) {
  if (Array.isArray(s))
    yield* clone(s)
  if (s.substr != null) {
    let r = memo.get(s)
    if (r == null) {
      let mod = null
      let js = s
      switch(s[0]) {
      case "=": // expression
      case "*": // list of statements
      case ">": // var declarator
        mod = s[0]
        js = s.slice(1)
      }
      const b = parse(js,{sourceType:"module",plugins:["dynamicImport"]})
      assert.equal(b.type, "File")
      assert.equal(b.program.type, "Program")
      if (!mod === "*")
        assert.equal(b.program.body.length, 1)
      switch(mod) {
      case "=":
        assert.equal(b.program.body[0].type, "ExpressionStatement")
        r = b.program.body[0].expression
        break
      case ">":
        assert.equal(b.program.body[0].type, "ExpressionStatement")
        const s = b.program.body[0].expression
        assert.equal(s.type,"AssignmentExpression")
        r = T.variableDeclarator(s.left,s.right)
        break
      case "*":
        break
      default:
        r = b.program.body[0]
      }
      if (mod === "=" || mod === ">") {
      } else if (mod === "*") {
        r = b.program.body
      } else {
        r = b.program.body[0]
      }
      memo.set(s,r)
    }
    s = r
  }
  if (Array.isArray(s)) {
    for(const i of s)
      yield* clone(produce(i,pos))
    
  } else
    yield* clone(produce(s,pos))
}

export function Template(Super) {
  const templateTok = {$:ctrlTokGen,
                       *run(t) {
                         yield* t._tstack.shift()
                       }}
  return class Template extends Super {
    constructor(cont) {
      super(cont)
      this._tstack = []
    }
    template(pos,node) {
      if (node.substr != null)
        node = toArray(toks(pos,node))
      this._stack.unshift(templateTok)
      this._tstack.unshift(node)
    }
    *open() {
      const arr = this._tstack[0]
      while(arr.length) {
        const f = arr.shift()
        if (f.enter) {
          switch(f.type) {
          case Tag.ExpressionStatement:
            const n = arr[0]
            if (n != null
                && n.type === Tag.Identifier
                && n.value.node.name === "$$")
            {
              while(arr.length && arr.shift().value !== f.value) {}
              return f.pos
            }
            break
          case Tag.Identifier:
            if (f.type === Tag.Identifier) {
              const n = f.value.node.name
              if (n === "$$" || n === "$E") {
                while(arr.length && arr.shift().value !== f.value) {}
                return f.pos
              }
            }
            break
          }
        }
        yield f
      }
      throw new Error("next placeholder is not found")
    }
  }
}

export function Stream(opts) {
  if (opts == null)
    opts = {}
  let Iterator = opts.input || opts.level || opts.peel
      ? (opts.arr ? ArrayLookahead : Lookahead)
      : NoInput
  if (opts.peel || opts.level)
    Iterator = Level(Iterator)
  if (opts.template || opts.output || opts.peel)
    Iterator = Output(Iterator)
  if (opts.peel)
    Iterator = WithPeel(Iterator)
  if (opts.template)
    Iterator = Template(Iterator)
  return Iterator
}

export const LookaheadArrStream = Stream({arr:true,input:true})
export const LookaheadStream = Stream({input:true})
export function lookahead(s) {
  // return Array.isArray(s) ? new LookaheadArrStream(s) : new LookaheadStream(s)
  return new LookaheadStream(s)
}

export const LevelStream = Stream({level:true})
export const LevelArrStream = Stream({level:true,arr:true})
export function levels(s) {
  //  return Array.isArray(s) ? new LevelStream(s) : new LevelArrStream(s)
  return new LevelStream(s)
}

export const AutoStream = Stream({peel:true,template:true})
export const AutoArrStream = Stream({peel:true,template:true,arr:true})
export function auto(s) {
  //  return Array.isArray(s) ? new AutoArrStream(s) : new AutoStream(s)
  return new AutoStream(s)
}


export class NoInput {}
export const OutputStream = Template(Output(NoInput))
export function output(s) {
  return new OutputStream(s)
}

export function skip(s) {
  const iter = s[Symbol.iterator]()
  let i
  for(;!(i = iter.next()).done;) {}
  return i.value
}

/**
  * modifies token replacing its `type` field
  */
export function setType(i,type) {
  return {enter:i.enter,leave:i.leave,type,pos:i.pos,value:i.value}
}

/**
  * modifies token replacing its `pos` field
  */
export function setPos(i,pos) {
  return {enter:i.enter,leave:i.leave,type:i.type,pos,value:i.value}
}

export const Subst = symbol("Subst","ctrl")

export function* completeSubst(s) {
  const sl = auto(s)
  function* subst(pos) {
    for(const i of sl.sub()) {
      if (i.type === Subst) {
        if (i.enter)
          yield* subst(pos)
      } else {
        yield sl.peel(setPos(i,pos))
        yield* walk()
        yield* sl.leave()
      }
    }
  }
  function* walk() {
    for(const i of sl.sub()) {
      if (i.type === Subst) {
        if (i.enter) {
          assert.ok(!i.leave)
          yield* subst(i.pos)
        }
      } else
        yield i
    }
  }
  yield* walk()
}

export function toArray(s) {
  return Array.isArray(s) ? s : Array.from(s)
}

export function result(s,buf) {
  const iter = s[Symbol.iterator]()
  let i
  for(;!(i = iter.next()).done;)
    buf.push(i.value)
  return i.value
}


ExtIterator.prototype.tillLevel = function(level) {
  return tillLevel(level,this)
}
/**
 * values until leaving specified level
 */
export function* tillLevel(level,s) {
  for(const i of s) {
    yield i
    if (i.leave && s.level === level)
      return
  }
}

export function* toBlockBody(s) {
  const lab = s.label()
  const i = s.cur()
  if (i.type === Tag.BlockStatement) {
    s.peel()
    skip(s.peelTo(Tag.body))
    return function*() {
      skip(lab())
    }
  } else {
    yield s.enter(Tag.push,Subst)
    return lab
  }
}

export function* inBlockBody(s,inner) {
  const lab = s.label()
  const i = s.cur()
  if (i.type !== Tag.BlockStatement) {
    yield s.enter(Tag.push,Subst)
    yield* inner
    yield* lab()
  } else {
    s.peel()
    skip(s.peelTo(Tag.body))
    yield* inner
    skip(lab())
  }
}

export function hasAnnot(node,name) {
  return node.leadingComments
    && node.leadingComments.length
    && node.leadingComments.find(v => v.value.trim() === name) !== undefined
}

export function* clone(s) {
  const stack = []
  for(const i of s) {
    let value = null
    if (i.enter) {
      stack.push(value = Object.assign({},i.value))
      const isArray = value.isArray = i.type === Tag.Array
      if (isArray)
        value.node = value.node.concat()
      else if (value.node != null && Tag[i.type] != null) {
        value.node = Object.assign({},value.node)
        if (value.node.leadingComments != null)
          value.node.leadingComments = value.node.leadingComments.concat()
        if (value.node.trealingComments != null)
          value.node.trealingComments = value.node.trealingComments.concat()
      }
    }
    if (i.leave)
      value = stack.pop()
    yield {enter:i.enter,leave:i.leave,type:i.type,pos:i.pos,value}
  }
}

/**
 * leaves all items un-amended until (and including) an item where 
 * `pred` is true
 */
export function* till(pred, s) {
  for(const i of s) {
    yield i
    if (pred(i))
      return i
  }
  return null
}
ExtIterator.prototype.till = function(pred) { return till(pred,this); }

export const find = R.curry(function* find(pred, s) {
  if (pred(s.cur()))
    return true
  for(const i of s) {
    if (pred(s.cur()))
      return true
    yield i
  }
})
ExtIterator.prototype.find = function(pred) { return find(pred,this); }

export const Opts = symbol("Options")
export const UpdateOpts = symbol("MergeOptions")

export function* concat(...args) {
  for(const i of args)
    yield* i
}


/**
 * shares single iterator between several uses
 */
export function share(s) {
  const i = s[Symbol.iterator]()
  return {
    [Symbol.iterator] () {
      return {
        next(v) {
          return i.next(v)
        }
      }
    }
  }
}

function saveLast(s) {
  const res = {
    [Symbol.iterator] () {
      const i = s[Symbol.iterator]()
      return {
        next(v) {
          return res.cur = i.next(v)
        }
      }
    }
  }
  return res
}

export const wrap = R.curry(function* wrap(name,f,s) {
  const babel = _opts.babel
  const si = auto(s)
  const iter = f(si)[Symbol.iterator]()
  let i
  try {
    let j
    for(;!(j = iter.next()).done;) {
      i = j.value
      yield i
    }
    return j.value
  } catch(e) {
    if (babel != null) {
      let msg = `${e.message} during ${name}`
      let node = e.esNode || i && i.value.node // || si._last
      if (!node || !node.loc && !node._loc) {
        msg += " (the position is approximated)"
        for(const i of si) {
          node = i.value.node
          if (node && (node.loc || node._loc))
            throw babel.root.hub.file.buildCodeFrameError(node, msg)
        }
        node = babel.root.node
      }
      throw babel.root.hub.file.buildCodeFrameError(node, msg)
    }
    throw e
  }
})

export const checkpointLazy = R.curry(function* checkpointLazy(name,s) {
  const babel = _opts.babel
  const iter = s[Symbol.iterator]()
  let last, i
  try {
    for(;;) {
      const j = iter.next()
      i = j.value
      if (j.done)
        return i
      if (i.enter && i.value.node != null && i.value.node.loc != null)
        last = i.value.node
      yield i
    }
  } catch(e) {
    if (babel != null) {
      const node = e.esNode || i && i.value.node || last
            || babel.root.node
      throw babel.root.hub.file.buildCodeFrameError(
        node, `${e.message} during ${name}`)
    }
    throw e
  }
})

export const checkpoint = R.curry(function(name,s) {
  return [...checkpointLazy(name,s)]
})

/**
 * babel plugin visitor methods, typically to be applied only to Program node
 */
export const babelBridge = R.curry(function babelBridge(pass,path,state) {
  const optSave = _opts
  _opts = Object.assign({args:Object.assign({},state.opts),
                         file:Object.assign(state.file.opts),
                         babel:{root:path,state}},
                       _opts)
  pass(produce(path.node))
  _opts = optSave
})

export const transform = R.curry(function transform(pass,ast,opts) {
  const optSave = _opts
  _opts = opts && {args:{},file:{},babel:false}
  try {
    return consume(pass(produce(ast))).top
  } finally {
    _opts = optSave
  }
})

/**
 * copies input stream to output and returns it as array
 */
export function* tee(s,buf) {
  if (buf == null)
    buf = []
  for(const i of s) {
    yield i
    buf.push(i)
  }
  return buf
}

ExtIterator.prototype.error = function(msg,node) {
  if (this._name != null)
    msg += " during " + this._name
  const e = new SyntaxError()
  if (node)
    e.esOrigNode = node
  if (!node || !node._loc && !node.loc) {
    msg += "(the position is approximated)"
    for(const i of this) {
      node = i.value.node
      if(node && (node.loc || node._loc)) {
        e.esNode = node
        return e
      }
    }
  }
  return e
}

export const makeExpr = symbol("makeExpr")
export const makeStmt = symbol("makeStmt")

export function makeExprPass(s) {
  s = auto(s)
  function* subst(pos) {
    const t = s.peel()
    yield s.enter(pos,t.type,t.value)
    yield* walk()
    yield* s.leave()
    skip(s.leave())
  }
  function* toExpr(pos) {
    const j = s.curLev()
    if (j == null)
      return
    if (j.type === makeExpr || j.type === makeStmt) {
      yield s.peel(j)
      yield* toExpr(pos)
      yield s.leave()
    } else {
      const ti = typeInfo(j)
      if (ti.block) {
        yield s.enter(pos,Tag.CallExpression)
        yield s.enter(Tag.callee,Tag.ArrowFunctionExpression,{node:{params:[]}})
        yield* subst(Tag.body)
        yield* s.leave()
        yield s.tok(Tag.arguments,Tag.Array)
        yield* s.leave()
      } else if (ti.stmt) {
        yield s.enter(pos,Tag.CallExpression)
        const lab = s.label()
        yield s.enter(Tag.callee,Tag.ArrowFunctionExpression,{node:{params:[]}})
        yield s.enter(Tag.body,Tag.BlockStatement)
        yield s.enter(Tag.body,Tag.Array)
        yield* subst(Tag.push)
        yield* lab()
        yield s.tok(Tag.arguments,Tag.Array)
        yield* s.leave()
      } else if (ti.expr) {
        yield* subst(pos)
      } else {
        throw new Error("internal: cannot convert to expression")
      }
    }
  }
  function* toStmt(pos) {
    const j = s.curLev()
    if (j == null)
      return
    if (j.type === makeExpr || j.type === makeStmt) {
      yield s.peel(j)
      yield* toStmt(pos)
      yield s.leave()
    } else {
      const ti = symInfo(j.type)
      if (ti.stmt || ti.block) {
        yield* subst(pos)
      } else {
        yield s.enter(pos,Tag.ExpressionStatement)
        yield* subst(Tag.expression)
        yield* s.leave()
      }
    }
  }
  function* walk(pos) {
    for(const i of s.sub()) {
      switch(i.type) {
      case makeExpr:
        if (i.enter) {
          pos = pos || i.pos
          yield* toExpr(pos)
        }
        break
      case makeStmt:
        if (i.enter) {
          pos = pos || i.pos
          yield* toStmt(pos)
        }
        break
      default:
        yield i
      }
    }
  }
  return walk()
}

/**
 * for expr/stmt if field type is different to actual value assigned 
 * it tries to change the value's type
 */
export const adjustFieldType = R.pipe(
  resetFieldInfo,
  function adjustFieldType(s) {
    s = auto(s)
    function* subst(pos,i) {
      if (i.leave) {
        yield s.tok(pos,i.type,i.value)
      } else {
        yield s.peel(setPos(i,pos))
        yield* walk()
        yield* s.leave()
      }
    }
    function* walk() {
      for(const i of s.sub()) {
        if (i.enter) {
          const fi = i.value.fieldInfo || {}, ti = typeInfo(i)
          /*
          if (fi.stmt && ti.stmt) {
            if (i.type === Tag.ExpressionStatement) {
              const j = s.value.curLev()
              if (j != null && j.value.result) {
                yield s.enter(i.pos,Tag.ReturnStatement)
                
              }
            }
            yield i
            continue
          } */
          if (fi.stmt && ti.stmt
              || fi.expr && ti.expr
              || fi.block && ti.block
              || i.type === Tag.VariableDeclaration && fi.decl)
          {
            yield i
            continue
          }
          if (fi.block && ti.expr) {
            const lab = s.label()
            yield s.enter(i.pos,Tag.BlockStatement)
            yield s.enter(Tag.body,Tag.Array)
            if (ti.expr) {
              if (i.value.result) {
                yield s.enter(Tag.push,Tag.ReturnStatement)
                yield* subst(Tag.argument,i)
              } else {
                yield s.enter(Tag.push,Tag.ExpressionStatement)
                yield* subst(Tag.expression,i)
              }
            } else {
              assert.ok(ti.stmt)
              yield* subst(Tag.push,i)
            }
            yield* lab()
            continue
          }
          if (fi.stmt && ti.expr) {
            if (i.value.result) {
              yield s.enter(i.pos,Tag.ReturnStatement)
              yield* subst(Tag.argument,i)
              yield* s.leave()
            } else {
              yield s.enter(i.pos,Tag.ExpressionStatement)
              yield* subst(Tag.expression,i)
              yield* s.leave()
            }
            continue
          }
          if (fi.expr && ti.stmt) {
            yield s.enter(i.pos,Tag.CallExpression)
            yield s.enter(Tag.callee,Tag.ArrowFunctionExpression,
                          {node:{params:[],expression:true}})
            yield* subst(Tag.body,i)
            yield* s.leave()
            yield s.tok(Tag.arguments,Tag.Array)
            yield* s.leave()
            continue
          }
        }
        yield i
      }
    }
    return walk()
  }
)

