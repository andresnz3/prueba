(() => {
  const databases = new Map();
  function clone(value) { return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)); }
  class MemoryTable {
    constructor(definition) {
      this.definition = definition;
      this.keyPath = definition.split(',')[0].replace(/^\+\+/, '').trim();
      this.autoIncrement = definition.split(',')[0].trim().startsWith('++');
      this.values = new Map();
      this.nextKey = 1;
    }
    async toArray() { return [...this.values.values()].map(clone); }
    async count() { return this.values.size; }
    async get(key) { const value = this.values.get(String(key)); return value === undefined ? undefined : clone(value); }
    async put(value) { return this.write(value); }
    async add(value) {
      const copy = clone(value);
      if (this.autoIncrement && copy[this.keyPath] === undefined) copy[this.keyPath] = this.nextKey++;
      const key = copy[this.keyPath];
      if (key === undefined || this.values.has(String(key))) throw new Error('Duplicate or missing key');
      this.values.set(String(key), copy);
      return key;
    }
    async write(value) {
      const copy = clone(value);
      if (this.autoIncrement && copy[this.keyPath] === undefined) copy[this.keyPath] = this.nextKey++;
      const key = copy[this.keyPath];
      if (key === undefined) throw new Error('Missing key');
      this.values.set(String(key), copy);
      return key;
    }
    async bulkPut(values) { for (const value of values) await this.write(value); }
    async delete(key) { this.values.delete(String(key)); }
    async clear() { this.values.clear(); }
    where(criteria) {
      const filter = expected => {
        const matches = value => typeof criteria === 'object' && criteria !== null
          ? Object.entries(criteria).every(([key, match]) => value[key] === match)
          : typeof criteria === 'string' && value[criteria] === expected;
        return {
          toArray: async () => (await this.toArray()).filter(matches),
          first: async () => (await this.toArray()).find(matches),
          count: async () => (await this.toArray()).filter(matches).length
        };
      };
      return { ...filter(undefined), equals: expected => filter(expected) };
    }
  }
  class MemoryDexie {
    constructor(name) {
      this.name = name;
      this._tableMap = databases.get(name) || new Map();
      databases.set(name, this._tableMap);
      return new Proxy(this, {
        get(target, property, receiver) {
          if (Reflect.has(target, property)) {
            const value = Reflect.get(target, property, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
          }
          if (typeof property === 'string') return target.table(property);
          return undefined;
        }
      });
    }
    get tables() { return [...this._tableMap].map(([name, table]) => { table.name = name; return table; }); }
    version() { return { stores: definitions => { for (const [name, definition] of Object.entries(definitions)) if (!this._tableMap.has(name)) this._tableMap.set(name, new MemoryTable(definition)); return this; } }; }
    table(name) {
      if (!this._tableMap.has(name)) this._tableMap.set(name, new MemoryTable('id'));
      return this._tableMap.get(name);
    }
    async open() { return this; }
    async transaction(...args) {
      const callback = args.at(-1);
      if (typeof callback !== 'function') throw new Error('Transaction callback is required');
      return callback();
    }
    close() {}
  }
  window.Dexie = MemoryDexie;
})();
