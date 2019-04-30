import {Ident, IdentSet, IdentGenerator, LSEQIdentGenerator, Segment} from './idents';
import {AtomList, ArrayAtomList} from './storage';
import {Op, OpKind, InsertOp, RemoveOp} from './Op';

/**
 * A CmRDT sequence that supports concurrent simultaneous editing
 * while preserving the intention of each edit.
 */
export class KSeq<T> {

  /**
   * The unique name of this replica.
   */
  name: string

  /**
   * The current logical time.
   */
  private time: number

  /**
   * The ordered list of atoms in the sequence.
   */
  private atoms: AtomList<T>

  /**
   * The set of idents of atoms that have been removed.
   */
  private removed: IdentSet

  /**
   * The generator used to create unique idents for new atoms.
   */
  private identGenerator: IdentGenerator

  /**
   * Creates an instance of KSeq<T>.
   * @param name           The unique name for this replica.
   * @param atoms          The backing storage, if null, creates a new ArrayAtomList<T>.
   * @param identGenerator The id generator, if null, creates a new LSEQIdentGenerator.
   * @returns An instance of KSeq<T>.
   */
  constructor(name: string, atoms?: AtomList<T>, identGenerator?: IdentGenerator) {
    this.name = name;
    this.time = 0;
    this.atoms = atoms || new ArrayAtomList<T>();
    this.removed = new IdentSet();
    this.identGenerator = identGenerator || new LSEQIdentGenerator();
  }

  /**
   * Gets the number of items in the sequence.
   * @returns The number of items in the sequence.
   */
  size(): number {
    return this.atoms.size();
  }

  /**
   * Gets the maximum depth of identifiers in the sequence.
   * @returns The depth of the sequence.
   */
  depth(): number {
    let max = 0;
    this.forEach((atom) => {
      let depth = atom.id.depth();
      if (max < depth) max = depth;
    });
    return max;
  }

  /**
   * Inserts a value into the sequence at the specified position.
   * @param value The value to insert.
   * @param pos   The position at which to insert the value.
   * @returns An InsertOp that can be applied to other KSeqs
   *          to reproduce the insertion.
   */
  insert(value: T, pos: number): InsertOp {
    if (pos < 0) throw new RangeError(`The position ${pos} must be greater than or equal to zero.`);

    let before = this.atoms.get(pos - 1);
    let after = this.atoms.get(pos);
    let id = this.identGenerator.getIdent(this.name, ++this.time, (before && before.id), (after && after.id));
    let op = new InsertOp(this.name, this.getWallTime(), id, value);
    this.apply(op);

    return op;
  }

  /**
   * Appends a value to the end of the sequence.
   * @param value The value to append.
   * @returns An InsertOp that can be applied to other KSeqs
   *          to reproduce the insertion.
   */
  append(value: T): InsertOp {
    return this.insert(value, this.size());
  }

  /**
   * Removes the value at the specified position from the sequence.
   * @param pos The position of the value to remove.
   * @returns An RemoveOp that can be applied to other KSeqs
   *          to reproduce the removal.
   */
  remove(pos: number): RemoveOp {
    if (pos < 0) throw new RangeError(`The position ${pos} must be greater than or equal to zero.`);

    let atom = this.atoms.get(pos);
    if (atom) {
      let op = new RemoveOp(this.name, this.getWallTime(), atom.id)
      this.apply(op);
      return op;
    }

    return null;
  }

  /**
   * Gets the value at the specified position in the sequence.
   * @param pos The desired position.
   * @returns The value at that position,
   *          or undefined if no such value exists.
   */
  get(pos: number): T {
    const atom = this.atoms.get(pos);
    return atom ? atom.value : undefined;
  }

  /**
   * Applies a function to each of the values in the sequence.
   * @param func The function to apply.
   */
  forEach(func: { (T): void }): void {
    this.atoms.forEach((atom) => func(atom.value));
  }

  /**
   * Applies a transformation function to each of the values in the sequence.
   * @param func The transformation function to apply.
   * @returns An array containing the results of the function calls.
   */
  map<R>(func: { (T): R }): R[] {
    return this.atoms.map((atom) => func(atom.value));
  }

  /**
   * Converts the sequence to an array.
   * @returns An array representation of the values in the sequence.
   */
  toArray(): T[] {
    return this.atoms.map((atom) => atom.value);
  }

  /**
   * Converts the sequence to a compact object suitable for serialization.
   * @returns A serializable object.
   */
  toJSON(): SerializedKSeq<T> {
    return {
      n: this.name,
      t: this.time,
      s: this.atoms.map((atom) => [atom.id.toString(), atom.value]) as Array<[string, T]>,
      r: this.removed.toJSON()
    }
  }

  /**
   * Load the given serialized KSeq structure into this instance of KSeq.
   * Does not load the KSeq name.
   */
  fromJSON(json: SerializedKSeq<T>) {
    this.time = json.t;
    for (const atom of json.s) {
      this.atoms.add(Ident.parse(atom[0]), atom[1]);
    }
  }

  /**
   * Applies the specified Op to the sequence. This can be used to apply
   * operations that have been generated by remote sequences.
   * @param op The Op to apply.
   */
  apply(op: Op): number {
    switch (op.kind) {
      case OpKind.Insert:
        let insertOp = <InsertOp> op;
        // If an atom with the specified ident has already been removed,
        // the ops have been received out of order. We should ignore the insert.
        if (!this.removed.has(insertOp.id)) {
          return this.atoms.add(insertOp.id, insertOp.value);
        }
        break;
      case OpKind.Remove:
        let removeOp = <RemoveOp> op;
        // Ignore repeated remove ops.
        if (!this.removed.has(removeOp.id)) {
          const pos = this.atoms.remove(removeOp.id);
          this.removed.add(removeOp.id);
          return pos;
        }
        break;
    }
    throw new Error(`Unknown op kind ${op.kind}`);
  }

  /**
   * Gets the current wall time as a UNIX epoch timestamp.
   * @returns An integer representing the wall time.
   */
  private getWallTime(): number {
    return Math.floor(new Date().valueOf() / 1000);
  }

}

export interface SerializedKSeq<T> {
  n: string; // name
  t: number; // time
  s: Array<[string, T]>; // array of serialized atoms
  r: Array<string>; // removed ids
}
