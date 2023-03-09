import _ from 'lodash'
import djb2 from 'djb2'

type JerryIndex = {
  pointer: Address,
  lookup: Map<Node, Address>,
  content: string
}

function indexNode(root, node = null, offset = 0, mode = null): JerryIndex {
  if (!node && root) return indexNode(root, root, offset)
  if (mode === 'blackbox') {
    // TODO: need better support for nested blackboxes
    if (node.dataset?.jerryType === 'signpost') {
      return indexNode(root, node, offset)
    } else if (node.nodeType === 3 || !node?.childNodes) {
      const address = new Address(root, offset, offset)
      const leafMap = new Map()
      leafMap.set(node, address)
      return {pointer: address, lookup: leafMap, content: ''}
    }
  } else if (node.nodeType === 3) {
    const address = new Address(root, offset, offset + node.length)
    const leafMap = new Map()
    leafMap.set(node, address)
    return {pointer: address, lookup: leafMap, content: node.textContent}
  } else if (!node?.childNodes) {
    const address = new Address(root, offset, offset)
    const leafMap = new Map()
    leafMap.set(node, address)
    return {pointer: address, lookup: leafMap, content: ''}
  }

  let recurseMode = node.dataset.jerryType || mode
  let content = ''
  let children = []
  let scanOffset = offset
  Array.from(node.childNodes).forEach(node => {
    const {pointer, lookup, content: c} = indexNode(root, node, scanOffset, recurseMode)
    children.push(lookup)
    content += c
    scanOffset = pointer.end
  })

  const pointer = new Address(root, offset, scanOffset)
  const selfMap = new Map()
  selfMap.set(node, pointer)

  return {
    pointer,
    lookup: new Map(_.flatMap([...children, selfMap], m => Array.from(m || []))),
    content,
  }
}

function filterMap<K, V>(map: Map<K, V>, f): Map<K, V> {
  return new Map(Array.from(map).filter(x => f(x[0], x[1])))
}

function isLeaf(node): node is Text {
  if (node.nodeType === 3) return true
  return false
}

type Direction = 'left' | 'right' | 'neither'

export class Address {
  root: Node
  start: number
  end: number
  bias: Direction

  constructor(root: Node, start: number, end: number, bias: Direction = 'left') {
    this.root = root
    this.start = start
    this.end = end
    this.bias = bias
  }

  getContent(): string {
    const {content} = indexNode(this.root)
    return content.substr(this.start, this.end - this.start)
  }

  getHash(): number {
    return djb2(this.getContent())
  }

  toLeafs(): Address[] {
    if (isLeaf(this.root)) return [this]
    if (!isLeaf(this.root) && !this.root.childNodes) return []
    const {lookup, content} = indexNode(this.root)
    const leafLookup = filterMap(lookup, isLeaf)

    const inverse = _.chain(Array.from(leafLookup))
      .filter(x => x[1].start !== x[1].end)
      .sortBy(x => x[1].start).value()
    if (this.start === this.end) {
      const item = _.findLast(inverse, x => x[1].start < this.start)
      return [new Address(item[0], this.start - item[1].start, this.start - item[1].start)]
    }
    const startItem = _.findLast(inverse, x => x[1].start <= this.start)
    const startIndex = inverse.indexOf(startItem)
    const [startNode, startSpan] = startItem
    const endItem = _.find(inverse, x => x[1].end >= this.end)
    const endIndex = inverse.indexOf(endItem)
    const [endNode, endSpan] = endItem
    const startSpot = this.start - startSpan.start
    const endSpot = this.end - endSpan.start
    if (startNode === endNode) return [new Address(startNode, startSpot, endSpot)]
    return [
      new Address(startNode, startSpot, startSpan.end - startSpan.start),
      ...(
        endIndex > startIndex + 1
          ? inverse.slice(startIndex + 1, endIndex).map(x =>
              new Address(x[0], 0, x[1].end - x[1].start)
          ) : []
      ),
      new Address(endNode, 0, endSpot),
    ]
  }

  select() {
    const leafs = this.toLeafs()
    window.getSelection().empty()
    if (_.isEmpty(leafs)) return
    let range = new Range()
    const first = leafs[0]
    const last = _.last(leafs)
    range.setStart(first.root, first.start)
    range.setEnd(last.root, last.end)
    document.getSelection().addRange(range)
  }

  toAtom() {
    if (!isLeaf(this.root)) return null
    if (this.start === 0 && this.end === this.root.length) {
      return this
    }
    const rest = this.root.splitText(this.start)
    const tail = rest.splitText(this.end - this.start)
    return new Address(tail.previousSibling, 0, this.end - this.start)
  }

  toAtoms() {
    return _.compact(this.toLeafs().map(x => x.toAtom()))
  }

  highlight(className = 'highlight') {
    // TODO: track highlight wrappers with a data-highlight attribute
    // this way various highlight classes can coexist well
    if (!isLeaf(this.root)) {
      return _.flatMap(this.toAtoms(), atom => atom.highlight(className))
    } else {
      const parentNode = this.root.parentNode as HTMLElement
      if (parentNode.dataset.jerryHighlight && parentNode.childNodes.length === 1) {
        if (parentNode.classList.contains(className)) {
          // if already has the highlight...
          if (parentNode.classList.length === 1) {
            // cleanup highlight wrapper element if it's the only class attached
            parentNode.parentNode.replaceChild(this.root, parentNode)
            this.root.parentNode.normalize()
          } else {
            // only remove the designated highlight class if there's another attached
            parentNode.classList.remove(className)
          }
          return []
        } else {
          // attach the designated class if it's not already there
          parentNode.classList.add(className)
          return [parentNode]
        }
      } else if (parentNode.dataset.jerryHighlight) {
        // cleanup when only part of the highlight needs to be inverted
        const nodes = Array.from(parentNode.childNodes)
        const parentClasses = Array.from(parentNode.classList)
        const nodeIndex = nodes.indexOf(this.root)
        const before = Array.from(nodes.slice(0, nodeIndex)).filter((x: any) => {
          if (x.nodeType === 3 && !x.length) return false
          return true
        })
        const after = nodes.slice(nodeIndex + 1)

        // remove middle/selected child and any coming after it
        parentNode.removeChild(this.root)
        after.forEach(afterNode => parentNode.removeChild(afterNode))

        let result = []
        let updatedMiddle = null
        if (parentClasses.includes(className) && parentClasses.length === 1) {
          // reinsert middle/selected child w/o wrapper
          if (parentNode.nextSibling) {
            parentNode.parentNode.insertBefore(this.root, parentNode.nextSibling)
          } else {
            parentNode.parentNode.appendChild(this.root)
          }
          updatedMiddle = this.root
        } else {
          // reinsert middle/selected child w/ wrapper
          const wrapped = document.createElement('span')
          wrapped.dataset.jerryHighlight = 'true'
          wrapped.contentEditable = 'false'
          parentClasses.forEach(c => wrapped.classList.add(c))
          wrapped.classList.add(className)
          if (parentClasses.includes(className)) wrapped.classList.remove(className)

          wrapped.appendChild(this.root)
          if (parentNode.nextSibling) {
            parentNode.parentNode.insertBefore(wrapped, parentNode.nextSibling)
          } else {
            parentNode.parentNode.appendChild(wrapped)
          }
          updatedMiddle = wrapped
          result = [wrapped]
        }

        // reinsert children coming after it, wrapped
        // TODO: somehow cleanup whitespace--avoid creating a whitespace-only wrapper
        if (after.length) {
          const wrapped = document.createElement('span')
          wrapped.dataset.jerryHighlight = 'true'
          wrapped.contentEditable = 'false'
          parentClasses.forEach(c => wrapped.classList.add(c))
          after.forEach((afterNode: any) => {
            if (afterNode.nodeType === 3 && !afterNode.length) return
            wrapped.appendChild(afterNode)
          })
          if (wrapped.childNodes.length) {
            if (updatedMiddle.nextSibling) {
              parentNode.parentNode.insertBefore(wrapped, updatedMiddle.nextSibling)
            } else {
              parentNode.parentNode.appendChild(wrapped)
            }
          }
        }

        // cleanup empty before section
        const container = parentNode.parentNode
        if (_.isEmpty(before)) {
            container.removeChild(parentNode)
        }

        container.normalize()

        return result
      } else {
        // wrap in a highlight element
        const wrapped = document.createElement('span')
        wrapped.dataset.jerryHighlight = 'true'
        wrapped.contentEditable = 'false'
        wrapped.classList.add(className)
        parentNode.replaceChild(wrapped, this.root)
        wrapped.appendChild(this.root)
        return [wrapped]
      }
    }
  }

  shift(offset: number): Address {
    return new Address(this.root, this.start + offset, this.end + offset)
  }

  includes(otherAddr: Address): boolean {
    if (otherAddr.root !== this.root) return false
    if (this.start <= otherAddr.start && this.end >= otherAddr.end) return true
    return false
  }

  rebase(targetNode: Node = document.body): Address {
    const {lookup} = indexNode(document.body)
    const rootAddr = lookup.get(this.root)
    const targetAddr = lookup.get(targetNode)
    const thisAddr = new Address(document.body, this.start, this.end).shift(rootAddr.start)
    if (!targetAddr.includes(thisAddr)) return null
    const shiftedAddr = thisAddr.shift(-targetAddr.start)
    return new Address(targetNode, shiftedAddr.start, shiftedAddr.end)
  }
}

export class Jerry {
  root: Node
  pointer: Address
  lookup: Map<Node, Address>

  constructor(root = document.body) {
    this.root = root
    this.refresh()
  }

  refresh() {
    const {lookup, pointer} = indexNode(this.root)
    this.pointer = pointer
    this.lookup = lookup
  }

  getNodeAddress(node): Address {
    return this.lookup.get(node)
  }

  static unionAddresses(addrs: Address[]): Address[] {
    // for now, don't union if not all addresses share a root
    if (!addrs.every(x => x.root === addrs[0].root) || _.isEmpty(addrs)) return addrs

    const sorted = _.sortBy(addrs, 'start')
    let union = [sorted[0]]
    sorted.slice(1).forEach(x => {
      const prev = _.last(union)
      if (prev.end < x.start) {
        union.push(x)
      } else {
        union[union.length - 1] = new Address(prev.root, prev.start, Math.max(prev.end, x.end))
      }
    })
    return union
  }

  getSelection(): Address {
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount) return null
    const range = sel.getRangeAt(0)
    const startOffset = this.getNodeAddress(range.startContainer)?.start
    const startMax = this.getNodeAddress(range.startContainer)?.end
    const start = Math.min(range.startOffset + startOffset, startMax)
    const endOffset = this.getNodeAddress(range.endContainer)?.start
    const endMax = this.getNodeAddress(range.endContainer)?.end
    const end = Math.min(range.endOffset + endOffset, endMax)
    return new Address(
      this.root,
      start,
      end,
      range.endOffset === 0 ? (range.startOffset === 0 ? 'neither' : 'right') : 'left'
    )
  }

  gatherHighlights(): Address[] {
    this.refresh()
    const nodes = Array.from((this.root as Element).querySelectorAll('[data-jerry-highlight]'))
    return Jerry.unionAddresses(nodes.map((node: Node) => this.lookup.get(node)))
  }

  serialize(): string[] {
    const highlights = this.gatherHighlights()
    return highlights.map(x => x.rebase()).map(addr => `body:${addr.start}-${addr.end}`)
  }

  deserialize(tokens: string[]): Address[] {
    return _.compact(tokens.map(token => {
      const [body, range] = token.split(':')
      const [start, end] = range.split('-')
      return new Address(document.body, +start, +end).rebase(this.root)
    }))
  }
}

export default Jerry
