// export const SWITCH_TO_STRUCTURE = 193; (easily collides with DELETE_AND_ADD + fieldIndex = 2)
const SWITCH_TO_STRUCTURE = 255; // (decoding collides with DELETE_AND_ADD + fieldIndex = 63)
const TYPE_ID = 213;
/**
 * Encoding Schema field operations.
 */
var OPERATION;
(function (OPERATION) {
    // add new structure/primitive
    OPERATION[OPERATION["ADD"] = 128] = "ADD";
    // replace structure/primitive
    OPERATION[OPERATION["REPLACE"] = 0] = "REPLACE";
    // delete field
    OPERATION[OPERATION["DELETE"] = 64] = "DELETE";
    // DELETE field, followed by an ADD
    OPERATION[OPERATION["DELETE_AND_ADD"] = 192] = "DELETE_AND_ADD";
    // TOUCH is used to determine hierarchy of nested Schema structures during serialization.
    // touches are NOT encoded.
    OPERATION[OPERATION["TOUCH"] = 1] = "TOUCH";
    // MapSchema Operations
    OPERATION[OPERATION["CLEAR"] = 10] = "CLEAR";
})(OPERATION || (OPERATION = {}));
// export enum OPERATION {
//     // add new structure/primitive
//     // (128)
//     ADD = 128, // 10000000,
//     // replace structure/primitive
//     REPLACE = 1,// 00000001
//     // delete field
//     DELETE = 192, // 11000000
//     // DELETE field, followed by an ADD
//     DELETE_AND_ADD = 224, // 11100000
//     // TOUCH is used to determine hierarchy of nested Schema structures during serialization.
//     // touches are NOT encoded.
//     TOUCH = 0, // 00000000
//     // MapSchema Operations
//     CLEAR = 10,
// }

//
// Root holds all schema references by unique id
//
class Root {
    //
    // Relation of refId => Schema structure
    // For direct access of structures during decoding time.
    //
    refs = new Map();
    refCounts = {};
    deletedRefs = new Set();
    nextUniqueId = 0;
    getNextUniqueId() {
        return this.nextUniqueId++;
    }
    // for decoding
    addRef(refId, ref, incrementCount = true) {
        this.refs.set(refId, ref);
        if (incrementCount) {
            this.refCounts[refId] = (this.refCounts[refId] || 0) + 1;
        }
    }
    // for decoding
    removeRef(refId) {
        this.refCounts[refId] = this.refCounts[refId] - 1;
        this.deletedRefs.add(refId);
    }
    clearRefs() {
        this.refs.clear();
        this.deletedRefs.clear();
        this.refCounts = {};
    }
    // for decoding
    garbageCollectDeletedRefs() {
        this.deletedRefs.forEach((refId) => {
            if (this.refCounts[refId] <= 0) {
                const ref = this.refs.get(refId);
                //
                // Ensure child schema instances have their references removed as well.
                //
                if (ref instanceof Schema) {
                    for (const fieldName in ref['_definition'].schema) {
                        if (typeof (ref['_definition'].schema[fieldName]) !== "string" &&
                            ref[fieldName] &&
                            ref[fieldName]['$changes']) {
                            this.removeRef(ref[fieldName]['$changes'].refId);
                        }
                    }
                }
                else {
                    const definition = ref['$changes'].parent._definition;
                    const type = definition.schema[definition.fieldsByIndex[ref['$changes'].parentIndex]];
                    if (typeof (Object.values(type)[0]) === "function") {
                        Array.from(ref.values())
                            .forEach((child) => this.removeRef(child['$changes'].refId));
                    }
                }
                this.refs.delete(refId);
                delete this.refCounts[refId];
            }
        });
        // clear deleted refs.
        this.deletedRefs.clear();
    }
}
class ChangeTree {
    ref;
    refId;
    root;
    parent;
    parentIndex;
    indexes;
    changed = false;
    changes = new Map();
    allChanges = new Set();
    // cached indexes for filtering
    caches = {};
    currentCustomOperation = 0;
    constructor(ref, parent, root) {
        this.ref = ref;
        this.setParent(parent, root);
    }
    setParent(parent, root, parentIndex) {
        if (!this.indexes) {
            this.indexes = (this.ref instanceof Schema)
                ? this.ref['_definition'].indexes
                : {};
        }
        this.parent = parent;
        this.parentIndex = parentIndex;
        // avoid setting parents with empty `root`
        if (!root) {
            return;
        }
        this.root = root;
        //
        // assign same parent on child structures
        //
        if (this.ref instanceof Schema) {
            const definition = this.ref['_definition'];
            for (let field in definition.schema) {
                const value = this.ref[field];
                if (value && value['$changes']) {
                    const parentIndex = definition.indexes[field];
                    value['$changes'].setParent(this.ref, root, parentIndex);
                }
            }
        }
        else if (typeof (this.ref) === "object") {
            this.ref.forEach((value, key) => {
                if (value instanceof Schema) {
                    const changeTreee = value['$changes'];
                    const parentIndex = this.ref['$changes'].indexes[key];
                    changeTreee.setParent(this.ref, this.root, parentIndex);
                }
            });
        }
    }
    operation(op) {
        this.changes.set(--this.currentCustomOperation, op);
    }
    change(fieldName, operation = OPERATION.ADD) {
        const index = (typeof (fieldName) === "number")
            ? fieldName
            : this.indexes[fieldName];
        this.assertValidIndex(index, fieldName);
        const previousChange = this.changes.get(index);
        if (!previousChange ||
            previousChange.op === OPERATION.DELETE ||
            previousChange.op === OPERATION.TOUCH // (mazmorra.io's BattleAction issue)
        ) {
            this.changes.set(index, {
                op: (!previousChange)
                    ? operation
                    : (previousChange.op === OPERATION.DELETE)
                        ? OPERATION.DELETE_AND_ADD
                        : operation,
                // : OPERATION.REPLACE,
                index
            });
        }
        this.allChanges.add(index);
        this.changed = true;
        this.touchParents();
    }
    touch(fieldName) {
        const index = (typeof (fieldName) === "number")
            ? fieldName
            : this.indexes[fieldName];
        this.assertValidIndex(index, fieldName);
        if (!this.changes.has(index)) {
            this.changes.set(index, { op: OPERATION.TOUCH, index });
        }
        this.allChanges.add(index);
        // ensure touch is placed until the $root is found.
        this.touchParents();
    }
    touchParents() {
        if (this.parent) {
            this.parent['$changes'].touch(this.parentIndex);
        }
    }
    getType(index) {
        if (this.ref['_definition']) {
            const definition = this.ref['_definition'];
            return definition.schema[definition.fieldsByIndex[index]];
        }
        else {
            const definition = this.parent['_definition'];
            const parentType = definition.schema[definition.fieldsByIndex[this.parentIndex]];
            //
            // Get the child type from parent structure.
            // - ["string"] => "string"
            // - { map: "string" } => "string"
            // - { set: "string" } => "string"
            //
            return Object.values(parentType)[0];
        }
    }
    getChildrenFilter() {
        const childFilters = this.parent['_definition'].childFilters;
        return childFilters && childFilters[this.parentIndex];
    }
    //
    // used during `.encode()`
    //
    getValue(index) {
        return this.ref['getByIndex'](index);
    }
    delete(fieldName) {
        const index = (typeof (fieldName) === "number")
            ? fieldName
            : this.indexes[fieldName];
        if (index === undefined) {
            console.warn(`@colyseus/schema ${this.ref.constructor.name}: trying to delete non-existing index: ${fieldName} (${index})`);
            return;
        }
        const previousValue = this.getValue(index);
        // console.log("$changes.delete =>", { fieldName, index, previousValue });
        this.changes.set(index, { op: OPERATION.DELETE, index });
        this.allChanges.delete(index);
        // delete cache
        delete this.caches[index];
        // remove `root` reference
        if (previousValue && previousValue['$changes']) {
            previousValue['$changes'].parent = undefined;
        }
        this.changed = true;
        this.touchParents();
    }
    discard(changed = false, discardAll = false) {
        //
        // Map, Array, etc:
        // Remove cached key to ensure ADD operations is unsed instead of
        // REPLACE in case same key is used on next patches.
        //
        // TODO: refactor this. this is not relevant for Collection and Set.
        //
        if (!(this.ref instanceof Schema)) {
            this.changes.forEach((change) => {
                if (change.op === OPERATION.DELETE) {
                    const index = this.ref['getIndex'](change.index);
                    delete this.indexes[index];
                }
            });
        }
        this.changes.clear();
        this.changed = changed;
        if (discardAll) {
            this.allChanges.clear();
        }
        // re-set `currentCustomOperation`
        this.currentCustomOperation = 0;
    }
    /**
     * Recursively discard all changes from this, and child structures.
     */
    discardAll() {
        this.changes.forEach((change) => {
            const value = this.getValue(change.index);
            if (value && value['$changes']) {
                value['$changes'].discardAll();
            }
        });
        this.discard();
    }
    // cache(field: number, beginIndex: number, endIndex: number) {
    cache(field, cachedBytes) {
        this.caches[field] = cachedBytes;
    }
    clone() {
        return new ChangeTree(this.ref, this.parent, this.root);
    }
    ensureRefId() {
        // skip if refId is already set.
        if (this.refId !== undefined) {
            return;
        }
        this.refId = this.root.getNextUniqueId();
    }
    assertValidIndex(index, fieldName) {
        if (index === undefined) {
            throw new Error(`ChangeTree: missing index for field "${fieldName}"`);
        }
    }
}

//
// Notes:
// -----
//
// - The tsconfig.json of @colyseus/schema uses ES2018.
// - ES2019 introduces `flatMap` / `flat`, which is not currently relevant, and caused other issues.
//
const DEFAULT_SORT = (a, b) => {
    const A = a.toString();
    const B = b.toString();
    if (A < B)
        return -1;
    else if (A > B)
        return 1;
    else
        return 0;
};
function getArrayProxy(value) {
    value['$proxy'] = true;
    //
    // compatibility with @colyseus/schema 0.5.x
    // - allow `map["key"]`
    // - allow `map["key"] = "xxx"`
    // - allow `delete map["key"]`
    //
    value = new Proxy(value, {
        get: (obj, prop) => {
            if (typeof (prop) !== "symbol" &&
                !isNaN(prop) // https://stackoverflow.com/a/175787/892698
            ) {
                return obj.at(prop);
            }
            else {
                return obj[prop];
            }
        },
        set: (obj, prop, setValue) => {
            if (typeof (prop) !== "symbol" &&
                !isNaN(prop)) {
                const indexes = Array.from(obj['$items'].keys());
                const key = parseInt(indexes[prop] || prop);
                if (setValue === undefined || setValue === null) {
                    obj.deleteAt(key);
                }
                else {
                    obj.setAt(key, setValue);
                }
            }
            else {
                obj[prop] = setValue;
            }
            return true;
        },
        deleteProperty: (obj, prop) => {
            if (typeof (prop) === "number") {
                obj.deleteAt(prop);
            }
            else {
                delete obj[prop];
            }
            return true;
        },
    });
    return value;
}
class ArraySchema {
    $changes = new ChangeTree(this);
    $items = new Map();
    $indexes = new Map();
    $refId = 0;
    //
    // Decoding callbacks
    //
    onAdd;
    onRemove;
    onChange;
    static is(type) {
        return (
        // type format: ["string"]
        Array.isArray(type) ||
            // type format: { array: "string" }
            (type['array'] !== undefined));
    }
    constructor(...items) {
        this.push.apply(this, items);
    }
    set length(value) {
        if (value === 0) {
            this.clear();
        }
        else {
            this.splice(value, this.length - value);
        }
    }
    get length() {
        return this.$items.size;
    }
    push(...values) {
        let lastIndex;
        values.forEach(value => {
            // set "index" for reference.
            lastIndex = this.$refId++;
            this.setAt(lastIndex, value);
        });
        return lastIndex;
    }
    /**
     * Removes the last element from an array and returns it.
     */
    pop() {
        const key = Array.from(this.$indexes.values()).pop();
        if (key === undefined) {
            return undefined;
        }
        this.$changes.delete(key);
        this.$indexes.delete(key);
        const value = this.$items.get(key);
        this.$items.delete(key);
        return value;
    }
    at(index) {
        //
        // FIXME: this should be O(1)
        //
        const key = Array.from(this.$items.keys())[index];
        return this.$items.get(key);
    }
    setAt(index, value) {
        if (value['$changes'] !== undefined) {
            value['$changes'].setParent(this, this.$changes.root, index);
        }
        const operation = this.$changes.indexes[index]?.op ?? OPERATION.ADD;
        this.$changes.indexes[index] = index;
        this.$indexes.set(index, index);
        this.$items.set(index, value);
        this.$changes.change(index, operation);
    }
    deleteAt(index) {
        const key = Array.from(this.$items.keys())[index];
        if (key === undefined) {
            return false;
        }
        return this.$deleteAt(key);
    }
    $deleteAt(index) {
        // delete at internal index
        this.$changes.delete(index);
        this.$indexes.delete(index);
        return this.$items.delete(index);
    }
    clear(isDecoding) {
        // discard previous operations.
        this.$changes.discard(true, true);
        this.$changes.indexes = {};
        // clear previous indexes
        this.$indexes.clear();
        // flag child items for garbage collection.
        if (isDecoding && typeof (this.$changes.getType()) !== "string") {
            this.$items.forEach((item) => {
                this.$changes.root.removeRef(item['$changes'].refId);
            });
        }
        // clear items
        this.$items.clear();
        this.$changes.operation({ index: 0, op: OPERATION.CLEAR });
        // touch all structures until reach root
        this.$changes.touchParents();
    }
    /**
     * Combines two or more arrays.
     * @param items Additional items to add to the end of array1.
     */
    concat(...items) {
        return new ArraySchema(...Array.from(this.$items.values()).concat(...items));
    }
    /**
     * Adds all the elements of an array separated by the specified separator string.
     * @param separator A string used to separate one element of an array from the next in the resulting String. If omitted, the array elements are separated with a comma.
     */
    join(separator) {
        return Array.from(this.$items.values()).join(separator);
    }
    /**
     * Reverses the elements in an Array.
     */
    reverse() {
        const indexes = Array.from(this.$items.keys());
        const reversedItems = Array.from(this.$items.values()).reverse();
        reversedItems.forEach((item, i) => {
            this.setAt(indexes[i], item);
        });
        return this;
    }
    /**
     * Removes the first element from an array and returns it.
     */
    shift() {
        const indexes = Array.from(this.$items.keys());
        const shiftAt = indexes.shift();
        if (shiftAt === undefined) {
            return undefined;
        }
        const value = this.$items.get(shiftAt);
        this.$deleteAt(shiftAt);
        return value;
    }
    /**
     * Returns a section of an array.
     * @param start The beginning of the specified portion of the array.
     * @param end The end of the specified portion of the array. This is exclusive of the element at the index 'end'.
     */
    slice(start, end) {
        return new ArraySchema(...Array.from(this.$items.values()).slice(start, end));
    }
    /**
     * Sorts an array.
     * @param compareFn Function used to determine the order of the elements. It is expected to return
     * a negative value if first argument is less than second argument, zero if they're equal and a positive
     * value otherwise. If omitted, the elements are sorted in ascending, ASCII character order.
     * ```ts
     * [11,2,22,1].sort((a, b) => a - b)
     * ```
     */
    sort(compareFn = DEFAULT_SORT) {
        const indexes = Array.from(this.$items.keys());
        const sortedItems = Array.from(this.$items.values()).sort(compareFn);
        sortedItems.forEach((item, i) => {
            this.setAt(indexes[i], item);
        });
        return this;
    }
    /**
     * Removes elements from an array and, if necessary, inserts new elements in their place, returning the deleted elements.
     * @param start The zero-based location in the array from which to start removing elements.
     * @param deleteCount The number of elements to remove.
     * @param items Elements to insert into the array in place of the deleted elements.
     */
    splice(start, deleteCount = this.length - start, ...items) {
        const indexes = Array.from(this.$items.keys());
        const removedItems = [];
        for (let i = start; i < start + deleteCount; i++) {
            removedItems.push(this.$items.get(indexes[i]));
            this.$deleteAt(indexes[i]);
        }
        return removedItems;
    }
    /**
     * Inserts new elements at the start of an array.
     * @param items  Elements to insert at the start of the Array.
     */
    unshift(...items) {
        const length = this.length;
        const addedLength = items.length;
        // const indexes = Array.from(this.$items.keys());
        const previousValues = Array.from(this.$items.values());
        items.forEach((item, i) => {
            this.setAt(i, item);
        });
        previousValues.forEach((previousValue, i) => {
            this.setAt(addedLength + i, previousValue);
        });
        return length + addedLength;
    }
    /**
     * Returns the index of the first occurrence of a value in an array.
     * @param searchElement The value to locate in the array.
     * @param fromIndex The array index at which to begin the search. If fromIndex is omitted, the search starts at index 0.
     */
    indexOf(searchElement, fromIndex) {
        return Array.from(this.$items.values()).indexOf(searchElement, fromIndex);
    }
    /**
     * Returns the index of the last occurrence of a specified value in an array.
     * @param searchElement The value to locate in the array.
     * @param fromIndex The array index at which to begin the search. If fromIndex is omitted, the search starts at the last index in the array.
     */
    lastIndexOf(searchElement, fromIndex = this.length - 1) {
        return Array.from(this.$items.values()).lastIndexOf(searchElement, fromIndex);
    }
    /**
     * Determines whether all the members of an array satisfy the specified test.
     * @param callbackfn A function that accepts up to three arguments. The every method calls
     * the callbackfn function for each element in the array until the callbackfn returns a value
     * which is coercible to the Boolean value false, or until the end of the array.
     * @param thisArg An object to which the this keyword can refer in the callbackfn function.
     * If thisArg is omitted, undefined is used as the this value.
     */
    every(callbackfn, thisArg) {
        return Array.from(this.$items.values()).every(callbackfn, thisArg);
    }
    /**
     * Determines whether the specified callback function returns true for any element of an array.
     * @param callbackfn A function that accepts up to three arguments. The some method calls
     * the callbackfn function for each element in the array until the callbackfn returns a value
     * which is coercible to the Boolean value true, or until the end of the array.
     * @param thisArg An object to which the this keyword can refer in the callbackfn function.
     * If thisArg is omitted, undefined is used as the this value.
     */
    some(callbackfn, thisArg) {
        return Array.from(this.$items.values()).some(callbackfn, thisArg);
    }
    /**
     * Performs the specified action for each element in an array.
     * @param callbackfn  A function that accepts up to three arguments. forEach calls the callbackfn function one time for each element in the array.
     * @param thisArg  An object to which the this keyword can refer in the callbackfn function. If thisArg is omitted, undefined is used as the this value.
     */
    forEach(callbackfn, thisArg) {
        Array.from(this.$items.values()).forEach(callbackfn, thisArg);
    }
    /**
     * Calls a defined callback function on each element of an array, and returns an array that contains the results.
     * @param callbackfn A function that accepts up to three arguments. The map method calls the callbackfn function one time for each element in the array.
     * @param thisArg An object to which the this keyword can refer in the callbackfn function. If thisArg is omitted, undefined is used as the this value.
     */
    map(callbackfn, thisArg) {
        return Array.from(this.$items.values()).map(callbackfn, thisArg);
    }
    filter(callbackfn, thisArg) {
        return Array.from(this.$items.values()).filter(callbackfn, thisArg);
    }
    /**
     * Calls the specified callback function for all the elements in an array. The return value of the callback function is the accumulated result, and is provided as an argument in the next call to the callback function.
     * @param callbackfn A function that accepts up to four arguments. The reduce method calls the callbackfn function one time for each element in the array.
     * @param initialValue If initialValue is specified, it is used as the initial value to start the accumulation. The first call to the callbackfn function provides this value as an argument instead of an array value.
     */
    reduce(callbackfn, initialValue) {
        return Array.prototype.reduce.apply(Array.from(this.$items.values()), arguments);
    }
    /**
     * Calls the specified callback function for all the elements in an array, in descending order. The return value of the callback function is the accumulated result, and is provided as an argument in the next call to the callback function.
     * @param callbackfn A function that accepts up to four arguments. The reduceRight method calls the callbackfn function one time for each element in the array.
     * @param initialValue If initialValue is specified, it is used as the initial value to start the accumulation. The first call to the callbackfn function provides this value as an argument instead of an array value.
     */
    reduceRight(callbackfn, initialValue) {
        return Array.prototype.reduceRight.apply(Array.from(this.$items.values()), arguments);
    }
    /**
     * Returns the value of the first element in the array where predicate is true, and undefined
     * otherwise.
     * @param predicate find calls predicate once for each element of the array, in ascending
     * order, until it finds one where predicate returns true. If such an element is found, find
     * immediately returns that element value. Otherwise, find returns undefined.
     * @param thisArg If provided, it will be used as the this value for each invocation of
     * predicate. If it is not provided, undefined is used instead.
     */
    find(predicate, thisArg) {
        return Array.from(this.$items.values()).find(predicate, thisArg);
    }
    /**
     * Returns the index of the first element in the array where predicate is true, and -1
     * otherwise.
     * @param predicate find calls predicate once for each element of the array, in ascending
     * order, until it finds one where predicate returns true. If such an element is found,
     * findIndex immediately returns that element index. Otherwise, findIndex returns -1.
     * @param thisArg If provided, it will be used as the this value for each invocation of
     * predicate. If it is not provided, undefined is used instead.
     */
    findIndex(predicate, thisArg) {
        return Array.from(this.$items.values()).findIndex(predicate, thisArg);
    }
    /**
     * Returns the this object after filling the section identified by start and end with value
     * @param value value to fill array section with
     * @param start index to start filling the array at. If start is negative, it is treated as
     * length+start where length is the length of the array.
     * @param end index to stop filling the array at. If end is negative, it is treated as
     * length+end.
     */
    fill(value, start, end) {
        //
        // TODO
        //
        throw new Error("ArraySchema#fill() not implemented");
    }
    /**
     * Returns the this object after copying a section of the array identified by start and end
     * to the same array starting at position target
     * @param target If target is negative, it is treated as length+target where length is the
     * length of the array.
     * @param start If start is negative, it is treated as length+start. If end is negative, it
     * is treated as length+end.
     * @param end If not specified, length of the this object is used as its default value.
     */
    copyWithin(target, start, end) {
        //
        // TODO
        //
        throw new Error("ArraySchema#copyWithin() not implemented");
    }
    /**
     * Returns a string representation of an array.
     */
    toString() { return this.$items.toString(); }
    /**
     * Returns a string representation of an array. The elements are converted to string using their toLocalString methods.
     */
    toLocaleString() { return this.$items.toLocaleString(); }
    ;
    /** Iterator */
    [Symbol.iterator]() {
        return Array.from(this.$items.values())[Symbol.iterator]();
    }
    [Symbol.unscopables]() {
        return this.$items[Symbol.unscopables]();
    }
    /**
     * Returns an iterable of key, value pairs for every entry in the array
     */
    entries() { return this.$items.entries(); }
    /**
     * Returns an iterable of keys in the array
     */
    keys() { return this.$items.keys(); }
    /**
     * Returns an iterable of values in the array
     */
    values() { return this.$items.values(); }
    /**
     * Determines whether an array includes a certain element, returning true or false as appropriate.
     * @param searchElement The element to search for.
     * @param fromIndex The position in this array at which to begin searching for searchElement.
     */
    includes(searchElement, fromIndex) {
        return Array.from(this.$items.values()).includes(searchElement, fromIndex);
    }
    /**
     * Calls a defined callback function on each element of an array. Then, flattens the result into
     * a new array.
     * This is identical to a map followed by flat with depth 1.
     *
     * @param callback A function that accepts up to three arguments. The flatMap method calls the
     * callback function one time for each element in the array.
     * @param thisArg An object to which the this keyword can refer in the callback function. If
     * thisArg is omitted, undefined is used as the this value.
     */
    // @ts-ignore
    flatMap(callback, thisArg) {
        // @ts-ignore
        throw new Error("ArraySchema#flatMap() is not supported.");
    }
    /**
     * Returns a new array with all sub-array elements concatenated into it recursively up to the
     * specified depth.
     *
     * @param depth The maximum recursion depth
     */
    // @ts-ignore
    flat(depth) {
        // @ts-ignore
        throw new Error("ArraySchema#flat() is not supported.");
    }
    // get size () {
    //     return this.$items.size;
    // }
    setIndex(index, key) {
        this.$indexes.set(index, key);
    }
    getIndex(index) {
        return this.$indexes.get(index);
    }
    getByIndex(index) {
        return this.$items.get(this.$indexes.get(index));
    }
    deleteByIndex(index) {
        const key = this.$indexes.get(index);
        this.$items.delete(key);
        this.$indexes.delete(index);
    }
    toArray() {
        return Array.from(this.$items.values());
    }
    toJSON() {
        return this.toArray().map((value) => {
            return (typeof (value['toJSON']) === "function")
                ? value['toJSON']()
                : value;
        });
    }
    //
    // Decoding utilities
    //
    clone(isDecoding) {
        let cloned;
        if (isDecoding) {
            cloned = new ArraySchema(...Array.from(this.$items.values()));
        }
        else {
            cloned = new ArraySchema(...this.map(item => ((item['$changes'])
                ? item.clone()
                : item)));
        }
        return cloned;
    }
    ;
    triggerAll() {
        Schema.prototype.triggerAll.apply(this);
    }
}

function getMapProxy(value) {
    value['$proxy'] = true;
    value = new Proxy(value, {
        get: (obj, prop) => {
            if (typeof (prop) !== "symbol" && // accessing properties
                typeof (obj[prop]) === "undefined") {
                return obj.get(prop);
            }
            else {
                return obj[prop];
            }
        },
        set: (obj, prop, setValue) => {
            if (typeof (prop) !== "symbol" &&
                (prop.indexOf("$") === -1 &&
                    prop !== "onAdd" &&
                    prop !== "onRemove" &&
                    prop !== "onChange")) {
                obj.set(prop, setValue);
            }
            else {
                obj[prop] = setValue;
            }
            return true;
        },
        deleteProperty: (obj, prop) => {
            obj.delete(prop);
            return true;
        },
    });
    return value;
}
class MapSchema {
    $changes = new ChangeTree(this);
    $items = new Map();
    $indexes = new Map();
    $refId = 0;
    //
    // Decoding callbacks
    //
    onAdd;
    onRemove;
    onChange;
    static is(type) {
        return type['map'] !== undefined;
    }
    constructor(initialValues) {
        if (initialValues) {
            if (initialValues instanceof Map) {
                initialValues.forEach((v, k) => this.set(k, v));
            }
            else {
                for (const k in initialValues) {
                    this.set(k, initialValues[k]);
                }
            }
        }
    }
    /** Iterator */
    [Symbol.iterator]() { return this.$items[Symbol.iterator](); }
    get [Symbol.toStringTag]() { return this.$items[Symbol.toStringTag]; }
    set(key, value) {
        if (value === undefined || value === null) {
            throw new Error(`MapSchema#set('${key}', ${value}): trying to set ${value} value on '${key}'.`);
        }
        // get "index" for this value.
        const hasIndex = typeof (this.$changes.indexes[key]) !== "undefined";
        const index = (hasIndex)
            ? this.$changes.indexes[key]
            : this.$refId++;
        let operation = (hasIndex)
            ? OPERATION.REPLACE
            : OPERATION.ADD;
        const isRef = (value['$changes']) !== undefined;
        if (isRef) {
            value['$changes'].setParent(this, this.$changes.root, index);
        }
        //
        // (encoding)
        // set a unique id to relate directly with this key/value.
        //
        if (!hasIndex) {
            this.$changes.indexes[key] = index;
            this.$indexes.set(index, key);
        }
        else if (isRef && // if is schema, force ADD operation if value differ from previous one.
            this.$items.get(key) !== value) {
            operation = OPERATION.ADD;
        }
        this.$items.set(key, value);
        this.$changes.change(key, operation);
        return this;
    }
    get(key) {
        return this.$items.get(key);
    }
    delete(key) {
        //
        // TODO: add a "purge" method after .encode() runs, to cleanup removed `$indexes`
        //
        // We don't remove $indexes to allow setting the same key in the same patch
        // (See "should allow to remove and set an item in the same place" test)
        //
        // // const index = this.$changes.indexes[key];
        // // this.$indexes.delete(index);
        this.$changes.delete(key);
        return this.$items.delete(key);
    }
    clear(isDecoding) {
        // discard previous operations.
        this.$changes.discard(true, true);
        this.$changes.indexes = {};
        // clear previous indexes
        this.$indexes.clear();
        // flag child items for garbage collection.
        if (isDecoding && typeof (this.$changes.getType()) !== "string") {
            this.$items.forEach((item) => {
                this.$changes.root.removeRef(item['$changes'].refId);
            });
        }
        // clear items
        this.$items.clear();
        this.$changes.operation({ index: 0, op: OPERATION.CLEAR });
        // touch all structures until reach root
        this.$changes.touchParents();
    }
    has(key) {
        return this.$items.has(key);
    }
    forEach(callbackfn) {
        this.$items.forEach(callbackfn);
    }
    entries() {
        return this.$items.entries();
    }
    keys() {
        return this.$items.keys();
    }
    values() {
        return this.$items.values();
    }
    get size() {
        return this.$items.size;
    }
    setIndex(index, key) {
        this.$indexes.set(index, key);
    }
    getIndex(index) {
        return this.$indexes.get(index);
    }
    getByIndex(index) {
        return this.$items.get(this.$indexes.get(index));
    }
    deleteByIndex(index) {
        const key = this.$indexes.get(index);
        this.$items.delete(key);
        this.$indexes.delete(index);
    }
    toJSON() {
        const map = {};
        this.forEach((value, key) => {
            map[key] = (typeof (value['toJSON']) === "function")
                ? value['toJSON']()
                : value;
        });
        return map;
    }
    //
    // Decoding utilities
    //
    clone(isDecoding) {
        let cloned;
        if (isDecoding) {
            // client-side
            cloned = Object.assign(new MapSchema(), this);
        }
        else {
            // server-side
            cloned = new MapSchema();
            this.forEach((value, key) => {
                if (value['$changes']) {
                    cloned.set(key, value['clone']());
                }
                else {
                    cloned.set(key, value);
                }
            });
        }
        return cloned;
    }
    triggerAll() {
        Schema.prototype.triggerAll.apply(this);
    }
}

const registeredTypes = {};
function registerType(identifier, definition) {
    registeredTypes[identifier] = definition;
}
function getType(identifier) {
    return registeredTypes[identifier];
}

class SchemaDefinition {
    schema;
    //
    // TODO: use a "field" structure combining all these properties per-field.
    //
    indexes = {};
    fieldsByIndex = {};
    filters;
    indexesWithFilters;
    childFilters; // childFilters are used on Map, Array, Set items.
    deprecated = {};
    descriptors = {};
    static create(parent) {
        const definition = new SchemaDefinition();
        // support inheritance
        definition.schema = Object.assign({}, parent && parent.schema || {});
        definition.indexes = Object.assign({}, parent && parent.indexes || {});
        definition.fieldsByIndex = Object.assign({}, parent && parent.fieldsByIndex || {});
        definition.descriptors = Object.assign({}, parent && parent.descriptors || {});
        definition.deprecated = Object.assign({}, parent && parent.deprecated || {});
        return definition;
    }
    addField(field, type) {
        const index = this.getNextFieldIndex();
        this.fieldsByIndex[index] = field;
        this.indexes[field] = index;
        this.schema[field] = (Array.isArray(type))
            ? { array: type[0] }
            : type;
    }
    addFilter(field, cb) {
        if (!this.filters) {
            this.filters = {};
            this.indexesWithFilters = [];
        }
        this.filters[this.indexes[field]] = cb;
        this.indexesWithFilters.push(this.indexes[field]);
        return true;
    }
    addChildrenFilter(field, cb) {
        const index = this.indexes[field];
        const type = this.schema[field];
        if (getType(Object.keys(type)[0])) {
            if (!this.childFilters) {
                this.childFilters = {};
            }
            this.childFilters[index] = cb;
            return true;
        }
        else {
            console.warn(`@filterChildren: field '${field}' can't have children. Ignoring filter.`);
        }
    }
    getChildrenFilter(field) {
        return this.childFilters && this.childFilters[this.indexes[field]];
    }
    getNextFieldIndex() {
        return Object.keys(this.schema || {}).length;
    }
}
function hasFilter(klass) {
    return klass._context && klass._context.useFilters;
}
class Context {
    types = {};
    schemas = new Map();
    useFilters = false;
    has(schema) {
        return this.schemas.has(schema);
    }
    get(typeid) {
        return this.types[typeid];
    }
    add(schema, typeid = this.schemas.size) {
        // FIXME: move this to somewhere else?
        // support inheritance
        schema._definition = SchemaDefinition.create(schema._definition);
        schema._typeid = typeid;
        this.types[typeid] = schema;
        this.schemas.set(schema, typeid);
    }
    static create(context = new Context) {
        return function (definition) {
            return type(definition, context);
        };
    }
}
const globalContext = new Context();
/**
 * `@type()` decorator for proxies
 */
function type(type, context = globalContext) {
    return function (target, field) {
        if (!type) {
            throw new Error("Type not found. Ensure your `@type` annotations are correct and that you don't have any circular dependencies.");
        }
        const constructor = target.constructor;
        constructor._context = context;
        /*
         * static schema
         */
        if (!context.has(constructor)) {
            context.add(constructor);
        }
        const definition = constructor._definition;
        definition.addField(field, type);
        /**
         * skip if descriptor already exists for this field (`@deprecated()`)
         */
        if (definition.descriptors[field]) {
            if (definition.deprecated[field]) {
                // do not create accessors for deprecated properties.
                return;
            }
            else {
                // trying to define same property multiple times across inheritance.
                // https://github.com/colyseus/colyseus-unity3d/issues/131#issuecomment-814308572
                try {
                    throw new Error(`@colyseus/schema: Duplicate '${field}' definition on '${constructor.name}'.\nCheck @type() annotation`);
                }
                catch (e) {
                    const definitionAtLine = e.stack.split("\n")[4].trim();
                    throw new Error(`${e.message} ${definitionAtLine}`);
                }
            }
        }
        const isArray = ArraySchema.is(type);
        const isMap = !isArray && MapSchema.is(type);
        // TODO: refactor me.
        // Allow abstract intermediary classes with no fields to be serialized
        // (See "should support an inheritance with a Schema type without fields" test)
        if (typeof (type) !== "string" && !Schema.is(type)) {
            const childType = Object.values(type)[0];
            if (typeof (childType) !== "string" && !context.has(childType)) {
                context.add(childType);
            }
        }
        const fieldCached = `_${field}`;
        definition.descriptors[fieldCached] = {
            enumerable: false,
            configurable: false,
            writable: true,
        };
        definition.descriptors[field] = {
            get: function () {
                return this[fieldCached];
            },
            set: function (value) {
                /**
                 * Create Proxy for array or map items
                 */
                // skip if value is the same as cached.
                if (value === this[fieldCached]) {
                    return;
                }
                if (value !== undefined &&
                    value !== null) {
                    // automaticallty transform Array into ArraySchema
                    if (isArray && !(value instanceof ArraySchema)) {
                        value = new ArraySchema(...value);
                    }
                    // automaticallty transform Map into MapSchema
                    if (isMap && !(value instanceof MapSchema)) {
                        value = new MapSchema(value);
                    }
                    // try to turn provided structure into a Proxy
                    if (value['$proxy'] === undefined) {
                        if (isMap) {
                            value = getMapProxy(value);
                        }
                        else if (isArray) {
                            value = getArrayProxy(value);
                        }
                    }
                    // flag the change for encoding.
                    this.$changes.change(field);
                    //
                    // call setParent() recursively for this and its child
                    // structures.
                    //
                    if (value['$changes']) {
                        value['$changes'].setParent(this, this.$changes.root, this._definition.indexes[field]);
                    }
                }
                else {
                    //
                    // Setting a field to `null` or `undefined` will delete it.
                    //
                    this.$changes.delete(field);
                }
                this[fieldCached] = value;
            },
            enumerable: true,
            configurable: true
        };
    };
}
/**
 * `@filter()` decorator for defining data filters per client
 */
function filter(cb) {
    return function (target, field) {
        const constructor = target.constructor;
        const definition = constructor._definition;
        if (definition.addFilter(field, cb)) {
            constructor._context.useFilters = true;
        }
    };
}
function filterChildren(cb) {
    return function (target, field) {
        const constructor = target.constructor;
        const definition = constructor._definition;
        if (definition.addChildrenFilter(field, cb)) {
            constructor._context.useFilters = true;
        }
    };
}
/**
 * `@deprecated()` flag a field as deprecated.
 * The previous `@type()` annotation should remain along with this one.
 */
function deprecated(throws = true, context = globalContext) {
    return function (target, field) {
        const constructor = target.constructor;
        const definition = constructor._definition;
        definition.deprecated[field] = true;
        if (throws) {
            definition.descriptors[field] = {
                get: function () { throw new Error(`${field} is deprecated.`); },
                set: function (value) { },
                enumerable: false,
                configurable: true
            };
        }
    };
}
function defineTypes(target, fields, context = target._context || globalContext) {
    for (let field in fields) {
        type(fields[field], context)(target.prototype, field);
    }
    return target;
}

/**
 * Copyright (c) 2018 Endel Dreyer
 * Copyright (c) 2014 Ion Drive Software Ltd.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE
 */
/**
 * msgpack implementation highly based on notepack.io
 * https://github.com/darrachequesne/notepack
 */
function utf8Length(str) {
    var c = 0, length = 0;
    for (var i = 0, l = str.length; i < l; i++) {
        c = str.charCodeAt(i);
        if (c < 0x80) {
            length += 1;
        }
        else if (c < 0x800) {
            length += 2;
        }
        else if (c < 0xd800 || c >= 0xe000) {
            length += 3;
        }
        else {
            i++;
            length += 4;
        }
    }
    return length;
}
function utf8Write(view, offset, str) {
    var c = 0;
    for (var i = 0, l = str.length; i < l; i++) {
        c = str.charCodeAt(i);
        if (c < 0x80) {
            view[offset++] = c;
        }
        else if (c < 0x800) {
            view[offset++] = 0xc0 | (c >> 6);
            view[offset++] = 0x80 | (c & 0x3f);
        }
        else if (c < 0xd800 || c >= 0xe000) {
            view[offset++] = 0xe0 | (c >> 12);
            view[offset++] = 0x80 | (c >> 6 & 0x3f);
            view[offset++] = 0x80 | (c & 0x3f);
        }
        else {
            i++;
            c = 0x10000 + (((c & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
            view[offset++] = 0xf0 | (c >> 18);
            view[offset++] = 0x80 | (c >> 12 & 0x3f);
            view[offset++] = 0x80 | (c >> 6 & 0x3f);
            view[offset++] = 0x80 | (c & 0x3f);
        }
    }
}
function int8$1(bytes, value) {
    bytes.push(value & 255);
}
function uint8$1(bytes, value) {
    bytes.push(value & 255);
}
function int16$1(bytes, value) {
    bytes.push(value & 255);
    bytes.push((value >> 8) & 255);
}
function uint16$1(bytes, value) {
    bytes.push(value & 255);
    bytes.push((value >> 8) & 255);
}
function int32$1(bytes, value) {
    bytes.push(value & 255);
    bytes.push((value >> 8) & 255);
    bytes.push((value >> 16) & 255);
    bytes.push((value >> 24) & 255);
}
function uint32$1(bytes, value) {
    const b4 = value >> 24;
    const b3 = value >> 16;
    const b2 = value >> 8;
    const b1 = value;
    bytes.push(b1 & 255);
    bytes.push(b2 & 255);
    bytes.push(b3 & 255);
    bytes.push(b4 & 255);
}
function int64$1(bytes, value) {
    const high = Math.floor(value / Math.pow(2, 32));
    const low = value >>> 0;
    uint32$1(bytes, low);
    uint32$1(bytes, high);
}
function uint64$1(bytes, value) {
    const high = (value / Math.pow(2, 32)) >> 0;
    const low = value >>> 0;
    uint32$1(bytes, low);
    uint32$1(bytes, high);
}
function float32$1(bytes, value) {
    writeFloat32(bytes, value);
}
function float64$1(bytes, value) {
    writeFloat64(bytes, value);
}
const _int32$1 = new Int32Array(2);
const _float32$1 = new Float32Array(_int32$1.buffer);
const _float64$1 = new Float64Array(_int32$1.buffer);
function writeFloat32(bytes, value) {
    _float32$1[0] = value;
    int32$1(bytes, _int32$1[0]);
}
function writeFloat64(bytes, value) {
    _float64$1[0] = value;
    int32$1(bytes, _int32$1[0 ]);
    int32$1(bytes, _int32$1[1 ]);
}
function boolean$1(bytes, value) {
    return uint8$1(bytes, value ? 1 : 0);
}
function string$1(bytes, value) {
    // encode `null` strings as empty.
    if (!value) {
        value = "";
    }
    let length = utf8Length(value);
    let size = 0;
    // fixstr
    if (length < 0x20) {
        bytes.push(length | 0xa0);
        size = 1;
    }
    // str 8
    else if (length < 0x100) {
        bytes.push(0xd9);
        uint8$1(bytes, length);
        size = 2;
    }
    // str 16
    else if (length < 0x10000) {
        bytes.push(0xda);
        uint16$1(bytes, length);
        size = 3;
    }
    // str 32
    else if (length < 0x100000000) {
        bytes.push(0xdb);
        uint32$1(bytes, length);
        size = 5;
    }
    else {
        throw new Error('String too long');
    }
    utf8Write(bytes, bytes.length, value);
    return size + length;
}
function number$1(bytes, value) {
    if (isNaN(value)) {
        return number$1(bytes, 0);
    }
    else if (!isFinite(value)) {
        return number$1(bytes, (value > 0) ? Number.MAX_SAFE_INTEGER : -Number.MAX_SAFE_INTEGER);
    }
    else if (value !== (value | 0)) {
        bytes.push(0xcb);
        writeFloat64(bytes, value);
        return 9;
        // TODO: encode float 32?
        // is it possible to differentiate between float32 / float64 here?
        // // float 32
        // bytes.push(0xca);
        // writeFloat32(bytes, value);
        // return 5;
    }
    if (value >= 0) {
        // positive fixnum
        if (value < 0x80) {
            uint8$1(bytes, value);
            return 1;
        }
        // uint 8
        if (value < 0x100) {
            bytes.push(0xcc);
            uint8$1(bytes, value);
            return 2;
        }
        // uint 16
        if (value < 0x10000) {
            bytes.push(0xcd);
            uint16$1(bytes, value);
            return 3;
        }
        // uint 32
        if (value < 0x100000000) {
            bytes.push(0xce);
            uint32$1(bytes, value);
            return 5;
        }
        // uint 64
        bytes.push(0xcf);
        uint64$1(bytes, value);
        return 9;
    }
    else {
        // negative fixnum
        if (value >= -0x20) {
            bytes.push(0xe0 | (value + 0x20));
            return 1;
        }
        // int 8
        if (value >= -0x80) {
            bytes.push(0xd0);
            int8$1(bytes, value);
            return 2;
        }
        // int 16
        if (value >= -0x8000) {
            bytes.push(0xd1);
            int16$1(bytes, value);
            return 3;
        }
        // int 32
        if (value >= -0x80000000) {
            bytes.push(0xd2);
            int32$1(bytes, value);
            return 5;
        }
        // int 64
        bytes.push(0xd3);
        int64$1(bytes, value);
        return 9;
    }
}

var encode = /*#__PURE__*/Object.freeze({
    __proto__: null,
    utf8Write: utf8Write,
    int8: int8$1,
    uint8: uint8$1,
    int16: int16$1,
    uint16: uint16$1,
    int32: int32$1,
    uint32: uint32$1,
    int64: int64$1,
    uint64: uint64$1,
    float32: float32$1,
    float64: float64$1,
    writeFloat32: writeFloat32,
    writeFloat64: writeFloat64,
    boolean: boolean$1,
    string: string$1,
    number: number$1
});

/**
 * Copyright (c) 2018 Endel Dreyer
 * Copyright (c) 2014 Ion Drive Software Ltd.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE
 */
function utf8Read(bytes, offset, length) {
    var string = '', chr = 0;
    for (var i = offset, end = offset + length; i < end; i++) {
        var byte = bytes[i];
        if ((byte & 0x80) === 0x00) {
            string += String.fromCharCode(byte);
            continue;
        }
        if ((byte & 0xe0) === 0xc0) {
            string += String.fromCharCode(((byte & 0x1f) << 6) |
                (bytes[++i] & 0x3f));
            continue;
        }
        if ((byte & 0xf0) === 0xe0) {
            string += String.fromCharCode(((byte & 0x0f) << 12) |
                ((bytes[++i] & 0x3f) << 6) |
                ((bytes[++i] & 0x3f) << 0));
            continue;
        }
        if ((byte & 0xf8) === 0xf0) {
            chr = ((byte & 0x07) << 18) |
                ((bytes[++i] & 0x3f) << 12) |
                ((bytes[++i] & 0x3f) << 6) |
                ((bytes[++i] & 0x3f) << 0);
            if (chr >= 0x010000) { // surrogate pair
                chr -= 0x010000;
                string += String.fromCharCode((chr >>> 10) + 0xD800, (chr & 0x3FF) + 0xDC00);
            }
            else {
                string += String.fromCharCode(chr);
            }
            continue;
        }
        console.error('Invalid byte ' + byte.toString(16));
        // (do not throw error to avoid server/client from crashing due to hack attemps)
        // throw new Error('Invalid byte ' + byte.toString(16));
    }
    return string;
}
function int8(bytes, it) {
    return uint8(bytes, it) << 24 >> 24;
}
function uint8(bytes, it) {
    return bytes[it.offset++];
}
function int16(bytes, it) {
    return uint16(bytes, it) << 16 >> 16;
}
function uint16(bytes, it) {
    return bytes[it.offset++] | bytes[it.offset++] << 8;
}
function int32(bytes, it) {
    return bytes[it.offset++] | bytes[it.offset++] << 8 | bytes[it.offset++] << 16 | bytes[it.offset++] << 24;
}
function uint32(bytes, it) {
    return int32(bytes, it) >>> 0;
}
function float32(bytes, it) {
    return readFloat32(bytes, it);
}
function float64(bytes, it) {
    return readFloat64(bytes, it);
}
function int64(bytes, it) {
    const low = uint32(bytes, it);
    const high = int32(bytes, it) * Math.pow(2, 32);
    return high + low;
}
function uint64(bytes, it) {
    const low = uint32(bytes, it);
    const high = uint32(bytes, it) * Math.pow(2, 32);
    return high + low;
}
const _int32 = new Int32Array(2);
const _float32 = new Float32Array(_int32.buffer);
const _float64 = new Float64Array(_int32.buffer);
function readFloat32(bytes, it) {
    _int32[0] = int32(bytes, it);
    return _float32[0];
}
function readFloat64(bytes, it) {
    _int32[0 ] = int32(bytes, it);
    _int32[1 ] = int32(bytes, it);
    return _float64[0];
}
function boolean(bytes, it) {
    return uint8(bytes, it) > 0;
}
function string(bytes, it) {
    const prefix = bytes[it.offset++];
    let length;
    if (prefix < 0xc0) {
        // fixstr
        length = prefix & 0x1f;
    }
    else if (prefix === 0xd9) {
        length = uint8(bytes, it);
    }
    else if (prefix === 0xda) {
        length = uint16(bytes, it);
    }
    else if (prefix === 0xdb) {
        length = uint32(bytes, it);
    }
    const value = utf8Read(bytes, it.offset, length);
    it.offset += length;
    return value;
}
function stringCheck(bytes, it) {
    const prefix = bytes[it.offset];
    return (
    // fixstr
    (prefix < 0xc0 && prefix > 0xa0) ||
        // str 8
        prefix === 0xd9 ||
        // str 16
        prefix === 0xda ||
        // str 32
        prefix === 0xdb);
}
function number(bytes, it) {
    const prefix = bytes[it.offset++];
    if (prefix < 0x80) {
        // positive fixint
        return prefix;
    }
    else if (prefix === 0xca) {
        // float 32
        return readFloat32(bytes, it);
    }
    else if (prefix === 0xcb) {
        // float 64
        return readFloat64(bytes, it);
    }
    else if (prefix === 0xcc) {
        // uint 8
        return uint8(bytes, it);
    }
    else if (prefix === 0xcd) {
        // uint 16
        return uint16(bytes, it);
    }
    else if (prefix === 0xce) {
        // uint 32
        return uint32(bytes, it);
    }
    else if (prefix === 0xcf) {
        // uint 64
        return uint64(bytes, it);
    }
    else if (prefix === 0xd0) {
        // int 8
        return int8(bytes, it);
    }
    else if (prefix === 0xd1) {
        // int 16
        return int16(bytes, it);
    }
    else if (prefix === 0xd2) {
        // int 32
        return int32(bytes, it);
    }
    else if (prefix === 0xd3) {
        // int 64
        return int64(bytes, it);
    }
    else if (prefix > 0xdf) {
        // negative fixint
        return (0xff - prefix + 1) * -1;
    }
}
function numberCheck(bytes, it) {
    const prefix = bytes[it.offset];
    // positive fixint - 0x00 - 0x7f
    // float 32        - 0xca
    // float 64        - 0xcb
    // uint 8          - 0xcc
    // uint 16         - 0xcd
    // uint 32         - 0xce
    // uint 64         - 0xcf
    // int 8           - 0xd0
    // int 16          - 0xd1
    // int 32          - 0xd2
    // int 64          - 0xd3
    return (prefix < 0x80 ||
        (prefix >= 0xca && prefix <= 0xd3));
}
function arrayCheck(bytes, it) {
    return bytes[it.offset] < 0xa0;
    // const prefix = bytes[it.offset] ;
    // if (prefix < 0xa0) {
    //   return prefix;
    // // array
    // } else if (prefix === 0xdc) {
    //   it.offset += 2;
    // } else if (0xdd) {
    //   it.offset += 4;
    // }
    // return prefix;
}
function switchStructureCheck(bytes, it) {
    return (
    // previous byte should be `SWITCH_TO_STRUCTURE`
    bytes[it.offset - 1] === SWITCH_TO_STRUCTURE &&
        // next byte should be a number
        (bytes[it.offset] < 0x80 || (bytes[it.offset] >= 0xca && bytes[it.offset] <= 0xd3)));
}

var decode = /*#__PURE__*/Object.freeze({
    __proto__: null,
    int8: int8,
    uint8: uint8,
    int16: int16,
    uint16: uint16,
    int32: int32,
    uint32: uint32,
    float32: float32,
    float64: float64,
    int64: int64,
    uint64: uint64,
    readFloat32: readFloat32,
    readFloat64: readFloat64,
    boolean: boolean,
    string: string,
    stringCheck: stringCheck,
    number: number,
    numberCheck: numberCheck,
    arrayCheck: arrayCheck,
    switchStructureCheck: switchStructureCheck
});

class CollectionSchema {
    $changes = new ChangeTree(this);
    $items = new Map();
    $indexes = new Map();
    $refId = 0;
    //
    // Decoding callbacks
    //
    onAdd;
    onRemove;
    onChange;
    static is(type) {
        return type['collection'] !== undefined;
    }
    constructor(initialValues) {
        if (initialValues) {
            initialValues.forEach((v) => this.add(v));
        }
    }
    add(value) {
        // set "index" for reference.
        const index = this.$refId++;
        const isRef = (value['$changes']) !== undefined;
        if (isRef) {
            value['$changes'].setParent(this, this.$changes.root, index);
        }
        this.$changes.indexes[index] = index;
        this.$indexes.set(index, index);
        this.$items.set(index, value);
        this.$changes.change(index);
        return index;
    }
    at(index) {
        const key = Array.from(this.$items.keys())[index];
        return this.$items.get(key);
    }
    entries() {
        return this.$items.entries();
    }
    delete(item) {
        const entries = this.$items.entries();
        let index;
        let entry;
        while (entry = entries.next()) {
            if (entry.done) {
                break;
            }
            if (item === entry.value[1]) {
                index = entry.value[0];
                break;
            }
        }
        if (index === undefined) {
            return false;
        }
        this.$changes.delete(index);
        this.$indexes.delete(index);
        return this.$items.delete(index);
    }
    clear(isDecoding) {
        // discard previous operations.
        this.$changes.discard(true, true);
        this.$changes.indexes = {};
        // clear previous indexes
        this.$indexes.clear();
        // flag child items for garbage collection.
        if (isDecoding && typeof (this.$changes.getType()) !== "string") {
            this.$items.forEach((item) => {
                this.$changes.root.removeRef(item['$changes'].refId);
            });
        }
        // clear items
        this.$items.clear();
        this.$changes.operation({ index: 0, op: OPERATION.CLEAR });
        // touch all structures until reach root
        this.$changes.touchParents();
    }
    has(value) {
        return Array.from(this.$items.values()).some((v) => v === value);
    }
    forEach(callbackfn) {
        this.$items.forEach((value, key, _) => callbackfn(value, key, this));
    }
    values() {
        return this.$items.values();
    }
    get size() {
        return this.$items.size;
    }
    setIndex(index, key) {
        this.$indexes.set(index, key);
    }
    getIndex(index) {
        return this.$indexes.get(index);
    }
    getByIndex(index) {
        return this.$items.get(this.$indexes.get(index));
    }
    deleteByIndex(index) {
        const key = this.$indexes.get(index);
        this.$items.delete(key);
        this.$indexes.delete(index);
    }
    toArray() {
        return Array.from(this.$items.values());
    }
    toJSON() {
        const values = [];
        this.forEach((value, key) => {
            values.push((typeof (value['toJSON']) === "function")
                ? value['toJSON']()
                : value);
        });
        return values;
    }
    //
    // Decoding utilities
    //
    clone(isDecoding) {
        let cloned;
        if (isDecoding) {
            // client-side
            cloned = Object.assign(new CollectionSchema(), this);
        }
        else {
            // server-side
            cloned = new CollectionSchema();
            this.forEach((value) => {
                if (value['$changes']) {
                    cloned.add(value['clone']());
                }
                else {
                    cloned.add(value);
                }
            });
        }
        return cloned;
    }
    triggerAll() {
        Schema.prototype.triggerAll.apply(this);
    }
}

class SetSchema {
    $changes = new ChangeTree(this);
    $items = new Map();
    $indexes = new Map();
    $refId = 0;
    //
    // Decoding callbacks
    //
    onAdd;
    onRemove;
    onChange;
    static is(type) {
        return type['set'] !== undefined;
    }
    constructor(initialValues) {
        if (initialValues) {
            initialValues.forEach((v) => this.add(v));
        }
    }
    add(value) {
        // immediatelly return false if value already added.
        if (this.has(value)) {
            return false;
        }
        // set "index" for reference.
        const index = this.$refId++;
        if ((value['$changes']) !== undefined) {
            value['$changes'].setParent(this, this.$changes.root, index);
        }
        const operation = this.$changes.indexes[index]?.op ?? OPERATION.ADD;
        this.$changes.indexes[index] = index;
        this.$indexes.set(index, index);
        this.$items.set(index, value);
        this.$changes.change(index, operation);
        return index;
    }
    entries() {
        return this.$items.entries();
    }
    delete(item) {
        const entries = this.$items.entries();
        let index;
        let entry;
        while (entry = entries.next()) {
            if (entry.done) {
                break;
            }
            if (item === entry.value[1]) {
                index = entry.value[0];
                break;
            }
        }
        if (index === undefined) {
            return false;
        }
        this.$changes.delete(index);
        this.$indexes.delete(index);
        return this.$items.delete(index);
    }
    clear(isDecoding) {
        // discard previous operations.
        this.$changes.discard(true, true);
        this.$changes.indexes = {};
        // clear previous indexes
        this.$indexes.clear();
        // flag child items for garbage collection.
        if (isDecoding && typeof (this.$changes.getType()) !== "string") {
            this.$items.forEach((item) => {
                this.$changes.root.removeRef(item['$changes'].refId);
            });
        }
        // clear items
        this.$items.clear();
        this.$changes.operation({ index: 0, op: OPERATION.CLEAR });
        // touch all structures until reach root
        this.$changes.touchParents();
    }
    has(value) {
        const values = this.$items.values();
        let has = false;
        let entry;
        while (entry = values.next()) {
            if (entry.done) {
                break;
            }
            if (value === entry.value) {
                has = true;
                break;
            }
        }
        return has;
    }
    forEach(callbackfn) {
        this.$items.forEach((value, key, _) => callbackfn(value, key, this));
    }
    values() {
        return this.$items.values();
    }
    get size() {
        return this.$items.size;
    }
    setIndex(index, key) {
        this.$indexes.set(index, key);
    }
    getIndex(index) {
        return this.$indexes.get(index);
    }
    getByIndex(index) {
        return this.$items.get(this.$indexes.get(index));
    }
    deleteByIndex(index) {
        const key = this.$indexes.get(index);
        this.$items.delete(key);
        this.$indexes.delete(index);
    }
    toArray() {
        return Array.from(this.$items.values());
    }
    toJSON() {
        const values = [];
        this.forEach((value, key) => {
            values.push((typeof (value['toJSON']) === "function")
                ? value['toJSON']()
                : value);
        });
        return values;
    }
    //
    // Decoding utilities
    //
    clone(isDecoding) {
        let cloned;
        if (isDecoding) {
            // client-side
            cloned = Object.assign(new SetSchema(), this);
        }
        else {
            // server-side
            cloned = new SetSchema();
            this.forEach((value) => {
                if (value['$changes']) {
                    cloned.add(value['clone']());
                }
                else {
                    cloned.add(value);
                }
            });
        }
        return cloned;
    }
    triggerAll() {
        Schema.prototype.triggerAll.apply(this);
    }
}

/**
 * Extracted from https://www.npmjs.com/package/strong-events
 */
class EventEmitter_ {
    handlers = [];
    register(cb, once = false) {
        this.handlers.push(cb);
        return this;
    }
    invoke(...args) {
        this.handlers.forEach((handler) => handler(...args));
    }
    invokeAsync(...args) {
        return Promise.all(this.handlers.map((handler) => handler(...args)));
    }
    remove(cb) {
        const index = this.handlers.indexOf(cb);
        this.handlers[index] = this.handlers[this.handlers.length - 1];
        this.handlers.pop();
    }
    clear() {
        this.handlers = [];
    }
}

class ClientState {
    refIds = new WeakSet();
    containerIndexes = new WeakMap();
    // containerIndexes = new Map<ChangeTree, Set<number>>();
    addRefId(changeTree) {
        if (!this.refIds.has(changeTree)) {
            this.refIds.add(changeTree);
            this.containerIndexes.set(changeTree, new Set());
        }
    }
    static get(client) {
        if (client.$filterState === undefined) {
            client.$filterState = new ClientState();
        }
        return client.$filterState;
    }
}

class EncodeSchemaError extends Error {
}
function assertType(value, type, klass, field) {
    let typeofTarget;
    let allowNull = false;
    switch (type) {
        case "number":
        case "int8":
        case "uint8":
        case "int16":
        case "uint16":
        case "int32":
        case "uint32":
        case "int64":
        case "uint64":
        case "float32":
        case "float64":
            typeofTarget = "number";
            if (isNaN(value)) {
                console.log(`trying to encode "NaN" in ${klass.constructor.name}#${field}`);
            }
            break;
        case "string":
            typeofTarget = "string";
            allowNull = true;
            break;
        case "boolean":
            // boolean is always encoded as true/false based on truthiness
            return;
    }
    if (typeof (value) !== typeofTarget && (!allowNull || (allowNull && value !== null))) {
        let foundValue = `'${JSON.stringify(value)}'${(value && value.constructor && ` (${value.constructor.name})`) || ''}`;
        throw new EncodeSchemaError(`a '${typeofTarget}' was expected, but ${foundValue} was provided in ${klass.constructor.name}#${field}`);
    }
}
function assertInstanceType(value, type, klass, field) {
    if (!(value instanceof type)) {
        throw new EncodeSchemaError(`a '${type.name}' was expected, but '${value.constructor.name}' was provided in ${klass.constructor.name}#${field}`);
    }
}
function encodePrimitiveType(type, bytes, value, klass, field) {
    assertType(value, type, klass, field);
    const encodeFunc = encode[type];
    if (encodeFunc) {
        encodeFunc(bytes, value);
    }
    else {
        throw new EncodeSchemaError(`a '${type}' was expected, but ${value} was provided in ${klass.constructor.name}#${field}`);
    }
}
function decodePrimitiveType(type, bytes, it) {
    return decode[type](bytes, it);
}
/**
 * Schema encoder / decoder
 */
class Schema {
    static _typeid;
    static _context;
    static _definition = SchemaDefinition.create();
    static onError(e) {
        console.error(e);
    }
    static is(type) {
        return (type['_definition'] &&
            type['_definition'].schema !== undefined);
    }
    $changes;
    // protected $root: ChangeSet;
    // TODO: refactor. this feature needs to be ported to other languages with potentially different API
    $listeners;
    // allow inherited classes to have a constructor
    constructor(...args) {
        // fix enumerability of fields for end-user
        Object.defineProperties(this, {
            $changes: {
                value: new ChangeTree(this, undefined, new Root()),
                enumerable: false,
                writable: true
            },
            $listeners: {
                value: {},
                enumerable: false,
                writable: true
            },
        });
        const descriptors = this._definition.descriptors;
        if (descriptors) {
            Object.defineProperties(this, descriptors);
        }
        //
        // Assign initial values
        //
        if (args[0]) {
            this.assign(args[0]);
        }
    }
    assign(props) {
        Object.assign(this, props);
        return this;
    }
    get _definition() { return this.constructor._definition; }
    listen(attr, callback) {
        if (!this.$listeners[attr]) {
            this.$listeners[attr] = new EventEmitter_();
        }
        this.$listeners[attr].register(callback);
        // return un-register callback.
        return () => this.$listeners[attr].remove(callback);
    }
    decode(bytes, it = { offset: 0 }, ref = this, allChanges = new Map()) {
        const $root = this.$changes.root;
        const totalBytes = bytes.length;
        let refId = 0;
        let changes = [];
        $root.refs.set(refId, this);
        allChanges.set(refId, changes);
        while (it.offset < totalBytes) {
            let byte = bytes[it.offset++];
            if (byte == SWITCH_TO_STRUCTURE) {
                refId = number(bytes, it);
                const nextRef = $root.refs.get(refId);
                //
                // Trying to access a reference that haven't been decoded yet.
                //
                if (!nextRef) {
                    throw new Error(`"refId" not found: ${refId}`);
                }
                ref = nextRef;
                // create empty list of changes for this refId.
                changes = [];
                allChanges.set(refId, changes);
                continue;
            }
            const changeTree = ref['$changes'];
            const isSchema = (ref['_definition'] !== undefined);
            const operation = (isSchema)
                ? (byte >> 6) << 6 // "compressed" index + operation
                : byte; // "uncompressed" index + operation (array/map items)
            if (operation === OPERATION.CLEAR) {
                //
                // TODO: refactor me!
                // The `.clear()` method is calling `$root.removeRef(refId)` for
                // each item inside this collection
                //
                ref.clear(true);
                continue;
            }
            const fieldIndex = (isSchema)
                ? byte % (operation || 255) // if "REPLACE" operation (0), use 255
                : number(bytes, it);
            const fieldName = (isSchema)
                ? (ref['_definition'].fieldsByIndex[fieldIndex])
                : "";
            let type = changeTree.getType(fieldIndex);
            let value;
            let previousValue;
            let dynamicIndex;
            if (!isSchema) {
                previousValue = ref['getByIndex'](fieldIndex);
                if ((operation & OPERATION.ADD) === OPERATION.ADD) { // ADD or DELETE_AND_ADD
                    dynamicIndex = (ref instanceof MapSchema)
                        ? string(bytes, it)
                        : fieldIndex;
                    ref['setIndex'](fieldIndex, dynamicIndex);
                }
                else {
                    // here
                    dynamicIndex = ref['getIndex'](fieldIndex);
                }
            }
            else {
                previousValue = ref[`_${fieldName}`];
            }
            //
            // Delete operations
            //
            if ((operation & OPERATION.DELETE) === OPERATION.DELETE) {
                if (operation !== OPERATION.DELETE_AND_ADD) {
                    ref['deleteByIndex'](fieldIndex);
                }
                // Flag `refId` for garbage collection.
                if (previousValue && previousValue['$changes']) {
                    $root.removeRef(previousValue['$changes'].refId);
                }
                value = null;
            }
            if (fieldName === undefined) {
                console.warn("@colyseus/schema: definition mismatch");
                //
                // keep skipping next bytes until reaches a known structure
                // by local decoder.
                //
                const nextIterator = { offset: it.offset };
                while (it.offset < totalBytes) {
                    if (switchStructureCheck(bytes, it)) {
                        nextIterator.offset = it.offset + 1;
                        if ($root.refs.has(number(bytes, nextIterator))) {
                            break;
                        }
                    }
                    it.offset++;
                }
                continue;
            }
            else if (operation === OPERATION.DELETE) ;
            else if (Schema.is(type)) {
                const refId = number(bytes, it);
                value = $root.refs.get(refId);
                if (operation !== OPERATION.REPLACE) {
                    const childType = this.getSchemaType(bytes, it, type);
                    if (!value) {
                        value = this.createTypeInstance(childType);
                        value.$changes.refId = refId;
                        if (previousValue) {
                            value.onChange = previousValue.onChange;
                            value.onRemove = previousValue.onRemove;
                            value.$listeners = previousValue.$listeners;
                            if (previousValue['$changes'].refId &&
                                refId !== previousValue['$changes'].refId) {
                                $root.removeRef(previousValue['$changes'].refId);
                            }
                        }
                    }
                    $root.addRef(refId, value, (value !== previousValue));
                }
            }
            else if (typeof (type) === "string") {
                //
                // primitive value (number, string, boolean, etc)
                //
                value = decodePrimitiveType(type, bytes, it);
            }
            else {
                const typeDef = getType(Object.keys(type)[0]);
                const refId = number(bytes, it);
                const valueRef = ($root.refs.has(refId))
                    ? previousValue || $root.refs.get(refId)
                    : new typeDef.constructor();
                value = valueRef.clone(true);
                value.$changes.refId = refId;
                // preserve schema callbacks
                if (previousValue) {
                    value.onAdd = previousValue.onAdd;
                    value.onRemove = previousValue.onRemove;
                    value.onChange = previousValue.onChange;
                    if (previousValue['$changes'].refId &&
                        refId !== previousValue['$changes'].refId) {
                        $root.removeRef(previousValue['$changes'].refId);
                        //
                        // Trigger onRemove if structure has been replaced.
                        //
                        const deletes = [];
                        const entries = previousValue.entries();
                        let iter;
                        while ((iter = entries.next()) && !iter.done) {
                            const [key, value] = iter.value;
                            deletes.push({
                                op: OPERATION.DELETE,
                                field: key,
                                value: undefined,
                                previousValue: value,
                            });
                        }
                        allChanges.set(previousValue['$changes'].refId, deletes);
                    }
                }
                $root.addRef(refId, value, (valueRef !== previousValue));
                //
                // TODO: deprecate proxies on next version.
                // get proxy to target value.
                //
                if (typeDef.getProxy) {
                    value = typeDef.getProxy(value);
                }
            }
            let hasChange = (previousValue !== value);
            if (value !== null &&
                value !== undefined) {
                if (value['$changes']) {
                    value['$changes'].setParent(changeTree.ref, changeTree.root, fieldIndex);
                }
                if (ref instanceof Schema) {
                    ref[fieldName] = value;
                    //
                    // FIXME: use `_field` instead of `field`.
                    //
                    // `field` is going to use the setter of the PropertyDescriptor
                    // and create a proxy for array/map. This is only useful for
                    // backwards-compatibility with @colyseus/schema@0.5.x
                    //
                    // // ref[_field] = value;
                }
                else if (ref instanceof MapSchema) {
                    // const key = ref['$indexes'].get(field);
                    const key = dynamicIndex;
                    // ref.set(key, value);
                    ref['$items'].set(key, value);
                }
                else if (ref instanceof ArraySchema) {
                    // const key = ref['$indexes'][field];
                    // console.log("SETTING FOR ArraySchema =>", { field, key, value });
                    // ref[key] = value;
                    ref.setAt(fieldIndex, value);
                }
                else if (ref instanceof CollectionSchema) {
                    const index = ref.add(value);
                    ref['setIndex'](fieldIndex, index);
                }
                else if (ref instanceof SetSchema) {
                    const index = ref.add(value);
                    if (index !== false) {
                        ref['setIndex'](fieldIndex, index);
                    }
                }
            }
            if (hasChange
            // &&
            // (
            //     this.onChange || ref.$listeners[field]
            // )
            ) {
                changes.push({
                    op: operation,
                    field: fieldName,
                    dynamicIndex,
                    value,
                    previousValue,
                });
            }
        }
        this._triggerChanges(allChanges);
        // drop references of unused schemas
        $root.garbageCollectDeletedRefs();
        return allChanges;
    }
    encode(encodeAll = false, bytes = [], useFilters = false) {
        const rootChangeTree = this.$changes;
        const refIdsVisited = new WeakSet();
        const changeTrees = [rootChangeTree];
        let numChangeTrees = 1;
        for (let i = 0; i < numChangeTrees; i++) {
            const changeTree = changeTrees[i];
            const ref = changeTree.ref;
            const isSchema = (ref instanceof Schema);
            // Generate unique refId for the ChangeTree.
            changeTree.ensureRefId();
            // mark this ChangeTree as visited.
            refIdsVisited.add(changeTree);
            // root `refId` is skipped.
            if (changeTree !== rootChangeTree &&
                (changeTree.changed || encodeAll)) {
                uint8$1(bytes, SWITCH_TO_STRUCTURE);
                number$1(bytes, changeTree.refId);
            }
            const changes = (encodeAll)
                ? Array.from(changeTree.allChanges)
                : Array.from(changeTree.changes.values());
            for (let j = 0, cl = changes.length; j < cl; j++) {
                const operation = (encodeAll)
                    ? { op: OPERATION.ADD, index: changes[j] }
                    : changes[j];
                const fieldIndex = operation.index;
                const field = (isSchema)
                    ? ref['_definition'].fieldsByIndex && ref['_definition'].fieldsByIndex[fieldIndex]
                    : fieldIndex;
                // cache begin index if `useFilters`
                const beginIndex = bytes.length;
                // encode field index + operation
                if (operation.op !== OPERATION.TOUCH) {
                    if (isSchema) {
                        //
                        // Compress `fieldIndex` + `operation` into a single byte.
                        // This adds a limitaion of 64 fields per Schema structure
                        //
                        uint8$1(bytes, (fieldIndex | operation.op));
                    }
                    else {
                        uint8$1(bytes, operation.op);
                        // custom operations
                        if (operation.op === OPERATION.CLEAR) {
                            continue;
                        }
                        // indexed operations
                        number$1(bytes, fieldIndex);
                    }
                }
                //
                // encode "alias" for dynamic fields (maps)
                //
                if (!isSchema &&
                    (operation.op & OPERATION.ADD) == OPERATION.ADD // ADD or DELETE_AND_ADD
                ) {
                    if (ref instanceof MapSchema) {
                        //
                        // MapSchema dynamic key
                        //
                        const dynamicIndex = changeTree.ref['$indexes'].get(fieldIndex);
                        string$1(bytes, dynamicIndex);
                    }
                }
                if (operation.op === OPERATION.DELETE) {
                    //
                    // TODO: delete from filter cache data.
                    //
                    // if (useFilters) {
                    //     delete changeTree.caches[fieldIndex];
                    // }
                    continue;
                }
                // const type = changeTree.childType || ref._schema[field];
                const type = changeTree.getType(fieldIndex);
                // const type = changeTree.getType(fieldIndex);
                const value = changeTree.getValue(fieldIndex);
                // Enqueue ChangeTree to be visited
                if (value &&
                    value['$changes'] &&
                    !refIdsVisited.has(value['$changes'])) {
                    changeTrees.push(value['$changes']);
                    value['$changes'].ensureRefId();
                    numChangeTrees++;
                }
                if (operation.op === OPERATION.TOUCH) {
                    continue;
                }
                if (Schema.is(type)) {
                    assertInstanceType(value, type, ref, field);
                    //
                    // Encode refId for this instance.
                    // The actual instance is going to be encoded on next `changeTree` iteration.
                    //
                    number$1(bytes, value.$changes.refId);
                    // Try to encode inherited TYPE_ID if it's an ADD operation.
                    if ((operation.op & OPERATION.ADD) === OPERATION.ADD) {
                        this.tryEncodeTypeId(bytes, type, value.constructor);
                    }
                }
                else if (typeof (type) === "string") {
                    //
                    // Primitive values
                    //
                    encodePrimitiveType(type, bytes, value, ref, field);
                }
                else {
                    //
                    // Custom type (MapSchema, ArraySchema, etc)
                    //
                    const definition = getType(Object.keys(type)[0]);
                    //
                    // ensure a ArraySchema has been provided
                    //
                    assertInstanceType(ref[`_${field}`], definition.constructor, ref, field);
                    //
                    // Encode refId for this instance.
                    // The actual instance is going to be encoded on next `changeTree` iteration.
                    //
                    number$1(bytes, value.$changes.refId);
                }
                if (useFilters) {
                    // cache begin / end index
                    changeTree.cache(fieldIndex, bytes.slice(beginIndex));
                }
            }
            if (!encodeAll && !useFilters) {
                changeTree.discard();
            }
        }
        return bytes;
    }
    encodeAll(useFilters) {
        return this.encode(true, [], useFilters);
    }
    applyFilters(client, encodeAll = false) {
        const root = this;
        const refIdsDissallowed = new Set();
        const $filterState = ClientState.get(client);
        const changeTrees = [this.$changes];
        let numChangeTrees = 1;
        let filteredBytes = [];
        for (let i = 0; i < numChangeTrees; i++) {
            const changeTree = changeTrees[i];
            if (refIdsDissallowed.has(changeTree.refId)) {
                // console.log("REFID IS NOT ALLOWED. SKIP.", { refId: changeTree.refId })
                continue;
            }
            const ref = changeTree.ref;
            const isSchema = ref instanceof Schema;
            uint8$1(filteredBytes, SWITCH_TO_STRUCTURE);
            number$1(filteredBytes, changeTree.refId);
            const clientHasRefId = $filterState.refIds.has(changeTree);
            const isEncodeAll = (encodeAll || !clientHasRefId);
            // console.log("REF:", ref.constructor.name);
            // console.log("Encode all?", isEncodeAll);
            //
            // include `changeTree` on list of known refIds by this client.
            //
            $filterState.addRefId(changeTree);
            const containerIndexes = $filterState.containerIndexes.get(changeTree);
            const changes = (isEncodeAll)
                ? Array.from(changeTree.allChanges)
                : Array.from(changeTree.changes.values());
            //
            // WORKAROUND: tries to re-evaluate previously not included @filter() attributes
            // - see "DELETE a field of Schema" test case.
            //
            if (!encodeAll &&
                isSchema &&
                ref._definition.indexesWithFilters) {
                const indexesWithFilters = ref._definition.indexesWithFilters;
                indexesWithFilters.forEach(indexWithFilter => {
                    if (!containerIndexes.has(indexWithFilter) &&
                        changeTree.allChanges.has(indexWithFilter)) {
                        if (isEncodeAll) {
                            changes.push(indexWithFilter);
                        }
                        else {
                            changes.push({ op: OPERATION.ADD, index: indexWithFilter, });
                        }
                    }
                });
            }
            for (let j = 0, cl = changes.length; j < cl; j++) {
                const change = (isEncodeAll)
                    ? { op: OPERATION.ADD, index: changes[j] }
                    : changes[j];
                // custom operations
                if (change.op === OPERATION.CLEAR) {
                    uint8$1(filteredBytes, change.op);
                    continue;
                }
                const fieldIndex = change.index;
                //
                // Deleting fields: encode the operation + field index
                //
                if (change.op === OPERATION.DELETE) {
                    //
                    // DELETE operations also need to go through filtering.
                    //
                    // TODO: cache the previous value so we can access the value (primitive or `refId`)
                    // (check against `$filterState.refIds`)
                    //
                    if (isSchema) {
                        uint8$1(filteredBytes, change.op | fieldIndex);
                    }
                    else {
                        uint8$1(filteredBytes, change.op);
                        number$1(filteredBytes, fieldIndex);
                    }
                    continue;
                }
                // indexed operation
                const value = changeTree.getValue(fieldIndex);
                const type = changeTree.getType(fieldIndex);
                if (isSchema) {
                    // Is a Schema!
                    const filter = (ref._definition.filters &&
                        ref._definition.filters[fieldIndex]);
                    if (filter && !filter.call(ref, client, value, root)) {
                        if (value && value['$changes']) {
                            refIdsDissallowed.add(value['$changes'].refId);
                        }
                        continue;
                    }
                }
                else {
                    // Is a collection! (map, array, etc.)
                    const parent = changeTree.parent;
                    const filter = changeTree.getChildrenFilter();
                    if (filter && !filter.call(parent, client, ref['$indexes'].get(fieldIndex), value, root)) {
                        if (value && value['$changes']) {
                            refIdsDissallowed.add(value['$changes'].refId);
                        }
                        continue;
                    }
                }
                // visit child ChangeTree on further iteration.
                if (value['$changes']) {
                    changeTrees.push(value['$changes']);
                    numChangeTrees++;
                }
                //
                // Copy cached bytes
                //
                if (change.op !== OPERATION.TOUCH) {
                    //
                    // TODO: refactor me!
                    //
                    if (change.op === OPERATION.ADD || isSchema) {
                        //
                        // use cached bytes directly if is from Schema type.
                        //
                        filteredBytes.push.apply(filteredBytes, changeTree.caches[fieldIndex] ?? []);
                        containerIndexes.add(fieldIndex);
                    }
                    else {
                        if (containerIndexes.has(fieldIndex)) {
                            //
                            // use cached bytes if already has the field
                            //
                            filteredBytes.push.apply(filteredBytes, changeTree.caches[fieldIndex] ?? []);
                        }
                        else {
                            //
                            // force ADD operation if field is not known by this client.
                            //
                            containerIndexes.add(fieldIndex);
                            uint8$1(filteredBytes, OPERATION.ADD);
                            number$1(filteredBytes, fieldIndex);
                            if (ref instanceof MapSchema) {
                                //
                                // MapSchema dynamic key
                                //
                                const dynamicIndex = changeTree.ref['$indexes'].get(fieldIndex);
                                string$1(filteredBytes, dynamicIndex);
                            }
                            if (value['$changes']) {
                                number$1(filteredBytes, value['$changes'].refId);
                            }
                            else {
                                // "encodePrimitiveType" without type checking.
                                // the type checking has been done on the first .encode() call.
                                encode[type](filteredBytes, value);
                            }
                        }
                    }
                }
                else if (value['$changes'] && !isSchema) {
                    //
                    // TODO:
                    // - track ADD/REPLACE/DELETE instances on `$filterState`
                    // - do NOT always encode dynamicIndex for MapSchema.
                    //   (If client already has that key, only the first index is necessary.)
                    //
                    uint8$1(filteredBytes, OPERATION.ADD);
                    number$1(filteredBytes, fieldIndex);
                    if (ref instanceof MapSchema) {
                        //
                        // MapSchema dynamic key
                        //
                        const dynamicIndex = changeTree.ref['$indexes'].get(fieldIndex);
                        string$1(filteredBytes, dynamicIndex);
                    }
                    number$1(filteredBytes, value['$changes'].refId);
                }
            }
        }
        return filteredBytes;
    }
    clone() {
        const cloned = new (this.constructor);
        const schema = this._definition.schema;
        for (let field in schema) {
            if (typeof (this[field]) === "object" &&
                typeof (this[field]?.clone) === "function") {
                // deep clone
                cloned[field] = this[field].clone();
            }
            else {
                // primitive values
                cloned[field] = this[field];
            }
        }
        return cloned;
    }
    triggerAll() {
        // skip if haven't received any remote refs yet.
        if (this.$changes.root.refs.size === 0) {
            return;
        }
        const allChanges = new Map();
        Schema.prototype._triggerAllFillChanges.call(this, this, allChanges);
        try {
            Schema.prototype._triggerChanges.call(this, allChanges);
        }
        catch (e) {
            Schema.onError(e);
        }
    }
    toJSON() {
        const schema = this._definition.schema;
        const deprecated = this._definition.deprecated;
        const obj = {};
        for (let field in schema) {
            if (!deprecated[field] && this[field] !== null && typeof (this[field]) !== "undefined") {
                obj[field] = (typeof (this[field]['toJSON']) === "function")
                    ? this[field]['toJSON']()
                    : this[`_${field}`];
            }
        }
        return obj;
    }
    discardAllChanges() {
        this.$changes.discardAll();
    }
    getByIndex(index) {
        return this[this._definition.fieldsByIndex[index]];
    }
    deleteByIndex(index) {
        this[this._definition.fieldsByIndex[index]] = undefined;
    }
    tryEncodeTypeId(bytes, type, targetType) {
        if (type._typeid !== targetType._typeid) {
            uint8$1(bytes, TYPE_ID);
            number$1(bytes, targetType._typeid);
        }
    }
    getSchemaType(bytes, it, defaultType) {
        let type;
        if (bytes[it.offset] === TYPE_ID) {
            it.offset++;
            type = this.constructor._context.get(number(bytes, it));
        }
        return type || defaultType;
    }
    createTypeInstance(type) {
        let instance = new type();
        // assign root on $changes
        instance.$changes.root = this.$changes.root;
        return instance;
    }
    _triggerAllFillChanges(ref, allChanges) {
        if (allChanges.has(ref['$changes'].refId)) {
            return;
        }
        const changes = [];
        allChanges.set(ref['$changes'].refId || 0, changes);
        if (ref instanceof Schema) {
            const schema = ref._definition.schema;
            for (let fieldName in schema) {
                const _field = `_${fieldName}`;
                const value = ref[_field];
                if (value !== undefined) {
                    changes.push({
                        op: OPERATION.ADD,
                        field: fieldName,
                        value,
                        previousValue: undefined
                    });
                    if (value['$changes'] !== undefined) {
                        Schema.prototype._triggerAllFillChanges.call(this, value, allChanges);
                    }
                }
            }
        }
        else {
            const entries = ref.entries();
            let iter;
            while ((iter = entries.next()) && !iter.done) {
                const [key, value] = iter.value;
                changes.push({
                    op: OPERATION.ADD,
                    field: key,
                    dynamicIndex: key,
                    value: value,
                    previousValue: undefined,
                });
                if (value['$changes'] !== undefined) {
                    Schema.prototype._triggerAllFillChanges.call(this, value, allChanges);
                }
            }
        }
    }
    _triggerChanges(allChanges) {
        allChanges.forEach((changes, refId) => {
            if (changes.length > 0) {
                const ref = this.$changes.root.refs.get(refId);
                const isSchema = ref instanceof Schema;
                for (let i = 0; i < changes.length; i++) {
                    const change = changes[i];
                    const listener = ref['$listeners'] && ref['$listeners'][change.field];
                    if (!isSchema) {
                        if (change.op === OPERATION.ADD && change.previousValue === undefined) {
                            ref.onAdd?.(change.value, change.dynamicIndex ?? change.field);
                        }
                        else if (change.op === OPERATION.DELETE) {
                            //
                            // FIXME: `previousValue` should always be avaiiable.
                            // ADD + DELETE operations are still encoding DELETE operation.
                            //
                            if (change.previousValue !== undefined) {
                                ref.onRemove?.(change.previousValue, change.dynamicIndex ?? change.field);
                            }
                        }
                        else if (change.op === OPERATION.DELETE_AND_ADD) {
                            if (change.previousValue !== undefined) {
                                ref.onRemove?.(change.previousValue, change.dynamicIndex);
                            }
                            ref.onAdd?.(change.value, change.dynamicIndex);
                        }
                        else if (change.op === OPERATION.REPLACE ||
                            change.value !== change.previousValue) {
                            ref.onChange?.(change.value, change.dynamicIndex);
                        }
                    }
                    //
                    // trigger onRemove on child structure.
                    //
                    if ((change.op & OPERATION.DELETE) === OPERATION.DELETE &&
                        change.previousValue instanceof Schema &&
                        change.previousValue.onRemove) {
                        change.previousValue.onRemove();
                    }
                    if (listener) {
                        try {
                            listener.invoke(change.value, change.previousValue);
                        }
                        catch (e) {
                            Schema.onError(e);
                        }
                    }
                }
                if (isSchema) {
                    if (ref.onChange) {
                        try {
                            ref.onChange(changes);
                        }
                        catch (e) {
                            Schema.onError(e);
                        }
                    }
                }
            }
        });
    }
}

function dumpChanges(schema) {
    const changeTrees = [schema['$changes']];
    let numChangeTrees = 1;
    const dump = {};
    let currentStructure = dump;
    for (let i = 0; i < numChangeTrees; i++) {
        const changeTree = changeTrees[i];
        changeTree.changes.forEach((change) => {
            const ref = changeTree.ref;
            const fieldIndex = change.index;
            const field = (ref['_definition'])
                ? ref['_definition'].fieldsByIndex[fieldIndex]
                : ref['$indexes'].get(fieldIndex);
            currentStructure[field] = changeTree.getValue(fieldIndex);
        });
    }
    return dump;
}

/******************************************************************************
Copyright (c) Microsoft Corporation.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
***************************************************************************** */

function __decorate(decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
}

const reflectionContext = new Context();
/**
 * Reflection
 */
class ReflectionField extends Schema {
    name;
    type;
    referencedType;
}
__decorate([
    type("string", reflectionContext)
], ReflectionField.prototype, "name", void 0);
__decorate([
    type("string", reflectionContext)
], ReflectionField.prototype, "type", void 0);
__decorate([
    type("number", reflectionContext)
], ReflectionField.prototype, "referencedType", void 0);
class ReflectionType extends Schema {
    id;
    fields = new ArraySchema();
}
__decorate([
    type("number", reflectionContext)
], ReflectionType.prototype, "id", void 0);
__decorate([
    type([ReflectionField], reflectionContext)
], ReflectionType.prototype, "fields", void 0);
class Reflection extends Schema {
    types = new ArraySchema();
    rootType;
    static encode(instance) {
        const rootSchemaType = instance.constructor;
        const reflection = new Reflection();
        reflection.rootType = rootSchemaType._typeid;
        const buildType = (currentType, schema) => {
            for (let fieldName in schema) {
                const field = new ReflectionField();
                field.name = fieldName;
                let fieldType;
                if (typeof (schema[fieldName]) === "string") {
                    fieldType = schema[fieldName];
                }
                else {
                    const type = schema[fieldName];
                    let childTypeSchema;
                    //
                    // TODO: refactor below.
                    //
                    if (Schema.is(type)) {
                        fieldType = "ref";
                        childTypeSchema = schema[fieldName];
                    }
                    else {
                        fieldType = Object.keys(type)[0];
                        if (typeof (type[fieldType]) === "string") {
                            fieldType += ":" + type[fieldType]; // array:string
                        }
                        else {
                            childTypeSchema = type[fieldType];
                        }
                    }
                    field.referencedType = (childTypeSchema)
                        ? childTypeSchema._typeid
                        : -1;
                }
                field.type = fieldType;
                currentType.fields.push(field);
            }
            reflection.types.push(currentType);
        };
        const types = rootSchemaType._context.types;
        for (let typeid in types) {
            const type = new ReflectionType();
            type.id = Number(typeid);
            buildType(type, types[typeid]._definition.schema);
        }
        return reflection.encodeAll();
    }
    static decode(bytes, it) {
        const context = new Context();
        const reflection = new Reflection();
        reflection.decode(bytes, it);
        const schemaTypes = reflection.types.reduce((types, reflectionType) => {
            const schema = class _ extends Schema {
            };
            const typeid = reflectionType.id;
            types[typeid] = schema;
            context.add(schema, typeid);
            return types;
        }, {});
        reflection.types.forEach((reflectionType) => {
            const schemaType = schemaTypes[reflectionType.id];
            reflectionType.fields.forEach(field => {
                if (field.referencedType !== undefined) {
                    let fieldType = field.type;
                    let refType = schemaTypes[field.referencedType];
                    // map or array of primitive type (-1)
                    if (!refType) {
                        const typeInfo = field.type.split(":");
                        fieldType = typeInfo[0];
                        refType = typeInfo[1];
                    }
                    if (fieldType === "ref") {
                        type(refType, context)(schemaType.prototype, field.name);
                    }
                    else {
                        type({ [fieldType]: refType }, context)(schemaType.prototype, field.name);
                    }
                }
                else {
                    type(field.type, context)(schemaType.prototype, field.name);
                }
            });
        });
        const rootType = schemaTypes[reflection.rootType];
        const rootInstance = new rootType();
        /**
         * auto-initialize referenced types on root type
         * to allow registering listeners immediatelly on client-side
         */
        for (let fieldName in rootType._definition.schema) {
            const fieldType = rootType._definition.schema[fieldName];
            if (typeof (fieldType) !== "string") {
                rootInstance[fieldName] = (typeof (fieldType) === "function")
                    ? new fieldType() // is a schema reference
                    : new (getType(Object.keys(fieldType)[0])).constructor(); // is a "collection"
            }
        }
        return rootInstance;
    }
}
__decorate([
    type([ReflectionType], reflectionContext)
], Reflection.prototype, "types", void 0);
__decorate([
    type("number", reflectionContext)
], Reflection.prototype, "rootType", void 0);

registerType("map", { constructor: MapSchema, getProxy: getMapProxy });
registerType("array", { constructor: ArraySchema, getProxy: getArrayProxy });
registerType("set", { constructor: SetSchema });
registerType("collection", { constructor: CollectionSchema, });

export { ArraySchema, CollectionSchema, Context, MapSchema, OPERATION, Reflection, ReflectionField, ReflectionType, Schema, SchemaDefinition, SetSchema, decode, defineTypes, deprecated, dumpChanges, encode, filter, filterChildren, hasFilter, registerType, type };
//# sourceMappingURL=index.mjs.map
