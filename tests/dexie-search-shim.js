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
      const matches = value => typeof criteria === 'object' && criteria !== null
        ? Object.entries(criteria).every(([key, expected]) => value[key] === expected)
        : false;
      return { toArray: async () => (await this.toArray()).filter(matches) };
    }
  }
  class MemoryDexie {
    constructor(name) {
      this.name = name;
      this.tables = databases.get(name) || new Map();
      databases.set(name, this.tables);
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
    version() { return { stores: definitions => { for (const [name, definition] of Object.entries(definitions)) if (!this.tables.has(name)) this.tables.set(name, new MemoryTable(definition)); return this; } }; }
    table(name) {
      if (!this.tables.has(name)) this.tables.set(name, new MemoryTable('id'));
      return this.tables.get(name);
    }
    async open() { return this; }
    close() {}
  }
  window.Dexie = MemoryDexie;
})();
