/**
 * Shared Operational Transformation (Firepad TextOperation),
 * Lexicographical Base62 (lexint) History ID Encoding,
 * Out-of-Order Doubly-Linked List History Buffer (Bn),
 * and Relay Global ID Encoding/Decoding.
 *
 * Works identically in Node.js (CommonJS) and Browser (`window.CodeshareOT`).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodeshareOT = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // =========================================================================
  // 1. Lexicographical Base62 (lexint) Encoder & Decoder (Module 19310)
  // =========================================================================
  const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const BASE62_MAP = {};
  for (let i = 0; i < BASE62_ALPHABET.length; i++) {
    BASE62_MAP[BASE62_ALPHABET[i]] = i;
  }

  function lengthPrefixChar(len, context) {
    const idx = len + 9;
    if (idx >= 62) {
      throw new Error(context + ': number not supported (too large)');
    }
    return BASE62_ALPHABET[idx];
  }

  function encodeHistoryIndex(num) {
    if (typeof num !== 'number' || isNaN(num) || num < 0 || !Number.isInteger(num)) {
      throw new Error('encode: number not supported (must be a positive integer or zero)');
    }
    let str = num === 0 ? '0' : '';
    let n = num;
    while (n > 0) {
      const rem = n % 62;
      str = BASE62_ALPHABET[rem] + str;
      n = (n - rem) / 62;
    }
    return lengthPrefixChar(str.length, 'encode') + str;
  }

  function decodeHistoryId(str) {
    if (typeof str !== 'string' || str.length < 2) {
      throw new Error('decode: invalid base62 (not a valid string)');
    }
    const prefix = str[0];
    if (!(prefix in BASE62_MAP)) {
      throw new Error('decode: invalid base62 ("' + str + '" not base62)');
    }
    const expectedPrefix = lengthPrefixChar(str.length - 1, 'decode');
    if (prefix !== expectedPrefix) {
      throw new Error('decode: number not supported (unexpected prefix)');
    }
    if (str[1] === '0' && expectedPrefix !== 'A') {
      throw new Error('decode: number not supported (unexpected leading zero)');
    }
    let value = 0;
    for (let i = 1; i < str.length; i++) {
      const ch = str[i];
      if (!(ch in BASE62_MAP)) {
        throw new Error('decode: invalid base62 ("' + str + '" not base62)');
      }
      value = value * 62 + BASE62_MAP[ch];
    }
    return value;
  }

  // =========================================================================
  // 2. Relay Global Object ID Helpers (Module 42195)
  // =========================================================================
  function toBase64(str) {
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(str, 'utf8').toString('base64');
    }
    return btoa(unescape(encodeURIComponent(str)));
  }

  function fromBase64(b64) {
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(b64, 'base64').toString('utf8');
    }
    return decodeURIComponent(escape(atob(b64)));
  }

  function formatRelayId(type, rawId) {
    const prefix = type + ':';
    if (String(rawId).startsWith(prefix)) {
      return String(rawId);
    }
    return prefix + rawId;
  }

  function parseRelayId(type, formatted) {
    const prefix = type + ':';
    if (!String(formatted).startsWith(prefix)) {
      throw new Error('invalid decoded relay id: ' + formatted);
    }
    return String(formatted).slice(prefix.length);
  }

  function encodeRelayId(type, rawId) {
    return toBase64(formatRelayId(type, rawId));
  }

  function decodeRelayId(type, encodedId) {
    const decoded = fromBase64(encodedId);
    return parseRelayId(type, decoded);
  }

  function encodeRelayConnId(index) {
    return encodeRelayId('arrayconnection', String(index));
  }

  function decodeRelayConnId(cursor) {
    return parseInt(decodeRelayId('arrayconnection', cursor), 10);
  }

  // =========================================================================
  // 3. Firepad Operational Transformation: TextOperation
  // =========================================================================
  class TextOperation {
    constructor() {
      this.ops = [];
      this.baseLength = 0;
      this.targetLength = 0;
    }

    static isRetain(op) {
      return typeof op === 'number' && op > 0;
    }

    static isInsert(op) {
      return typeof op === 'string';
    }

    static isDelete(op) {
      return typeof op === 'number' && op < 0;
    }

    equals(other) {
      if (this.baseLength !== other.baseLength) return false;
      if (this.targetLength !== other.targetLength) return false;
      if (this.ops.length !== other.ops.length) return false;
      for (let i = 0; i < this.ops.length; i++) {
        if (this.ops[i] !== other.ops[i]) return false;
      }
      return true;
    }

    retain(n) {
      if (typeof n !== 'number') throw new Error('retain expects an integer');
      if (n === 0) return this;
      this.baseLength += n;
      this.targetLength += n;
      if (TextOperation.isRetain(this.ops[this.ops.length - 1])) {
        this.ops[this.ops.length - 1] += n;
      } else {
        this.ops.push(n);
      }
      return this;
    }

    insert(str) {
      if (typeof str !== 'string') throw new Error('insert expects a string');
      if (str === '') return this;
      this.targetLength += str.length;
      const ops = this.ops;
      if (TextOperation.isInsert(ops[ops.length - 1])) {
        ops[ops.length - 1] += str;
      } else if (TextOperation.isDelete(ops[ops.length - 1])) {
        // Canonical order: insert before delete
        if (TextOperation.isInsert(ops[ops.length - 2])) {
          ops[ops.length - 2] += str;
        } else {
          ops.push(ops[ops.length - 1]);
          ops[ops.length - 2] = str;
        }
      } else {
        ops.push(str);
      }
      return this;
    }

    delete(n) {
      if (typeof n === 'string') n = n.length;
      if (typeof n !== 'number') throw new Error('delete expects an integer or a string');
      if (n === 0) return this;
      if (n > 0) n = -n;
      this.baseLength -= n;
      if (TextOperation.isDelete(this.ops[this.ops.length - 1])) {
        this.ops[this.ops.length - 1] += n;
      } else {
        this.ops.push(n);
      }
      return this;
    }

    isNoop() {
      return (
        this.ops.length === 0 ||
        (this.ops.length === 1 && TextOperation.isRetain(this.ops[0]))
      );
    }

    toJSON() {
      return this.ops.slice();
    }

    static fromJSON(ops) {
      const o = new TextOperation();
      const arr = typeof ops === 'string' ? JSON.parse(ops) : ops;
      for (let i = 0; i < arr.length; i++) {
        const op = arr[i];
        if (TextOperation.isRetain(op)) {
          o.retain(op);
        } else if (TextOperation.isInsert(op)) {
          o.insert(op);
        } else if (TextOperation.isDelete(op)) {
          o.delete(op);
        } else {
          throw new Error('unknown operation: ' + JSON.stringify(op));
        }
      }
      return o;
    }

    apply(str) {
      if (str.length !== this.baseLength) {
        throw new Error(
          `The operation's base length (${this.baseLength}) must be equal to the string's length (${str.length}).`
        );
      }
      const newParts = [];
      let strIndex = 0;
      for (let i = 0; i < this.ops.length; i++) {
        const op = this.ops[i];
        if (TextOperation.isRetain(op)) {
          if (strIndex + op > str.length) {
            throw new Error("Operation can't retain more characters than are left in the string.");
          }
          newParts.push(str.slice(strIndex, strIndex + op));
          strIndex += op;
        } else if (TextOperation.isInsert(op)) {
          newParts.push(op);
        } else {
          strIndex -= op;
        }
      }
      if (strIndex !== str.length) {
        throw new Error("The operation didn't operate on the whole string.");
      }
      return newParts.join('');
    }

    invert(str) {
      let strIndex = 0;
      const inverse = new TextOperation();
      const ops = this.ops;
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i];
        if (TextOperation.isRetain(op)) {
          inverse.retain(op);
          strIndex += op;
        } else if (TextOperation.isInsert(op)) {
          inverse.delete(op.length);
        } else {
          inverse.insert(str.slice(strIndex, strIndex - op));
          strIndex -= op;
        }
      }
      return inverse;
    }

    compose(operation2) {
      const operation1 = this;
      if (operation1.targetLength !== operation2.baseLength) {
        throw new Error(
          `The base length of the second operation (${operation2.baseLength}) has to be the target length of the first operation (${operation1.targetLength})`
        );
      }
      const operation = new TextOperation();
      const ops1 = operation1.ops;
      const ops2 = operation2.ops;
      let i1 = 0;
      let i2 = 0;
      let op1 = ops1[i1++];
      let op2 = ops2[i2++];

      while (typeof op1 !== 'undefined' || typeof op2 !== 'undefined') {
        if (TextOperation.isDelete(op1)) {
          operation.delete(op1);
          op1 = ops1[i1++];
          continue;
        }
        if (TextOperation.isInsert(op2)) {
          operation.insert(op2);
          op2 = ops2[i2++];
          continue;
        }
        if (typeof op1 === 'undefined') {
          throw new Error('Cannot compose operations: first operation is too short.');
        }
        if (typeof op2 === 'undefined') {
          throw new Error('Cannot compose operations: first operation is too long.');
        }

        if (TextOperation.isRetain(op1) && TextOperation.isRetain(op2)) {
          if (op1 > op2) {
            operation.retain(op2);
            op1 = op1 - op2;
            op2 = ops2[i2++];
          } else if (op1 === op2) {
            operation.retain(op1);
            op1 = ops1[i1++];
            op2 = ops2[i2++];
          } else {
            operation.retain(op1);
            op2 = op2 - op1;
            op1 = ops1[i1++];
          }
        } else if (TextOperation.isInsert(op1) && TextOperation.isDelete(op2)) {
          if (op1.length > -op2) {
            op1 = op1.slice(-op2);
            op2 = ops2[i2++];
          } else if (op1.length === -op2) {
            op1 = ops1[i1++];
            op2 = ops2[i2++];
          } else {
            op2 = op2 + op1.length;
            op1 = ops1[i1++];
          }
        } else if (TextOperation.isInsert(op1) && TextOperation.isRetain(op2)) {
          if (op1.length > op2) {
            operation.insert(op1.slice(0, op2));
            op1 = op1.slice(op2);
            op2 = ops2[i2++];
          } else if (op1.length === op2) {
            operation.insert(op1);
            op1 = ops1[i1++];
            op2 = ops2[i2++];
          } else {
            operation.insert(op1);
            op2 = op2 - op1.length;
            op1 = ops1[i1++];
          }
        } else if (TextOperation.isRetain(op1) && TextOperation.isDelete(op2)) {
          if (op1 > -op2) {
            operation.delete(op2);
            op1 = op1 + op2;
            op2 = ops2[i2++];
          } else if (op1 === -op2) {
            operation.delete(op2);
            op1 = ops1[i1++];
            op2 = ops2[i2++];
          } else {
            operation.delete(op1);
            op2 = op2 + op1;
            op1 = ops1[i1++];
          }
        } else {
          throw new Error('Unreachable compose state');
        }
      }
      return operation;
    }

    static transform(operation1, operation2) {
      if (operation1.baseLength !== operation2.baseLength) {
        throw new Error('Both operations have to have the same base length');
      }
      const operation1prime = new TextOperation();
      const operation2prime = new TextOperation();
      const ops1 = operation1.ops;
      const ops2 = operation2.ops;
      let i1 = 0;
      let i2 = 0;
      let op1 = ops1[i1++];
      let op2 = ops2[i2++];

      while (typeof op1 !== 'undefined' || typeof op2 !== 'undefined') {
        if (TextOperation.isInsert(op1)) {
          operation1prime.insert(op1);
          operation2prime.retain(op1.length);
          op1 = ops1[i1++];
          continue;
        }
        if (TextOperation.isInsert(op2)) {
          operation1prime.retain(op2.length);
          operation2prime.insert(op2);
          op2 = ops2[i2++];
          continue;
        }
        if (typeof op1 === 'undefined') {
          throw new Error('Cannot transform operations: first operation is too short.');
        }
        if (typeof op2 === 'undefined') {
          throw new Error('Cannot transform operations: first operation is too long.');
        }

        let minl;
        if (TextOperation.isRetain(op1) && TextOperation.isRetain(op2)) {
          if (op1 > op2) {
            minl = op2;
            op1 = op1 - op2;
            op2 = ops2[i2++];
          } else if (op1 === op2) {
            minl = op2;
            op1 = ops1[i1++];
            op2 = ops2[i2++];
          } else {
            minl = op1;
            op2 = op2 - op1;
            op1 = ops1[i1++];
          }
          operation1prime.retain(minl);
          operation2prime.retain(minl);
        } else if (TextOperation.isDelete(op1) && TextOperation.isDelete(op2)) {
          if (-op1 > -op2) {
            op1 = op1 - op2;
            op2 = ops2[i2++];
          } else if (op1 === op2) {
            op1 = ops1[i1++];
            op2 = ops2[i2++];
          } else {
            op2 = op2 - op1;
            op1 = ops1[i1++];
          }
        } else if (TextOperation.isDelete(op1) && TextOperation.isRetain(op2)) {
          if (-op1 > op2) {
            minl = op2;
            op1 = op1 + op2;
            op2 = ops2[i2++];
          } else if (-op1 === op2) {
            minl = op2;
            op1 = ops1[i1++];
            op2 = ops2[i2++];
          } else {
            minl = -op1;
            op2 = op2 + op1;
            op1 = ops1[i1++];
          }
          operation1prime.delete(minl);
        } else if (TextOperation.isRetain(op1) && TextOperation.isDelete(op2)) {
          if (op1 > -op2) {
            minl = -op2;
            op1 = op1 + op2;
            op2 = ops2[i2++];
          } else if (op1 === -op2) {
            minl = op1;
            op1 = ops1[i1++];
            op2 = ops2[i2++];
          } else {
            minl = op1;
            op2 = op2 + op1;
            op1 = ops1[i1++];
          }
          operation2prime.delete(minl);
        } else {
          throw new Error("The two operations aren't compatible");
        }
      }
      return [operation1prime, operation2prime];
    }

    transformCursor(pos) {
      let newPos = pos;
      let index = 0;
      for (let i = 0; i < this.ops.length; i++) {
        const op = this.ops[i];
        if (TextOperation.isRetain(op)) {
          index += op;
        } else if (TextOperation.isInsert(op)) {
          if (index <= pos) {
            newPos += op.length;
          }
        } else if (TextOperation.isDelete(op)) {
          const delLen = -op;
          if (pos > index) {
            newPos -= Math.min(delLen, pos - index);
          }
          index += delLen;
        }
      }
      return Math.max(0, newPos);
    }
  }

  // =========================================================================
  // 4. Doubly-Linked List + Out-Of-Order History Buffer (Bn in pages_[codeshareId])
  // =========================================================================
  class ListNode {
    constructor(key, val, prev, next) {
      this.key = key;
      this.val = val;
      this.prev = prev || null;
      this.next = next || null;
    }
  }

  class DoublyLinkedList {
    constructor() {
      this.head = null;
      this.tail = null;
    }
    push(key, val) {
      const node = new ListNode(key, val, this.tail, null);
      if (this.tail) {
        this.tail.next = node;
      } else {
        this.head = node;
      }
      this.tail = node;
      return node;
    }
  }

  class OrderedHistoryBuffer {
    constructor() {
      this.list = new DoublyLinkedList();
      this.map = new Map();
      this.outOfOrder = new Map();
    }

    has(index) {
      return this.map.has(index);
    }

    get(index) {
      const node = this.map.get(index);
      return node ? node.val : undefined;
    }

    isOutOfOrder(index) {
      return this.outOfOrder.has(index);
    }

    get size() {
      return this.map.size;
    }

    set(index, edge) {
      if (this.has(index)) return this;
      const isInitialOrContiguous =
        index <= 0 || this.has(index - 1);

      if (!isInitialOrContiguous) {
        this.outOfOrder.set(index, edge);
        return this;
      }

      const node = this.list.push(index, edge);
      this.map.set(index, node);

      // Drain any contiguous operations waiting in outOfOrder
      let nextIdx = index + 1;
      while (this.outOfOrder.has(nextIdx)) {
        const queuedEdge = this.outOfOrder.get(nextIdx);
        this.outOfOrder.delete(nextIdx);
        const nextNode = this.list.push(nextIdx, queuedEdge);
        this.map.set(nextIdx, nextNode);
        nextIdx++;
      }
      return this;
    }

    lastHistoryId() {
      if (!this.list.tail || this.list.tail.key === -1) {
        const checkpoint = this.get(-1);
        if (checkpoint && checkpoint.codeHistoryEdge) {
          const hId = checkpoint.codeHistoryEdge.node.historyId;
          return [hId, decodeHistoryId(hId)];
        }
        return [null, -1];
      }
      const edge = this.list.tail.val;
      const hId = edge.node.historyId;
      return [hId, decodeHistoryId(hId)];
    }

    nextHistoryId() {
      const [, lastIdx] = this.lastHistoryId();
      const nextIdx = lastIdx + 1;
      return [encodeHistoryIndex(nextIdx), nextIdx];
    }

    *entries() {
      let curr = this.list.head;
      while (curr) {
        yield [curr.key, curr.val];
        curr = curr.next;
      }
    }
  }

  return {
    TextOperation,
    OrderedHistoryBuffer,
    encodeHistoryIndex,
    decodeHistoryId,
    encodeRelayId,
    decodeRelayId,
    formatRelayId,
    parseRelayId,
    encodeRelayConnId,
    decodeRelayConnId,
  };
});

