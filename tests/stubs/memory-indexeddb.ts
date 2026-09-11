/**
 * IndexedDB في الذاكرة — لاختبار طبقةِ التخزين بلا اعتماديّةٍ جديدة.
 *
 * ── لماذا لا مكتبةٌ جاهزة ──
 *
 * إضافةُ اعتماديّةٍ لأجل اختبارٍ واحد تُدخل شيفرةً غريبةً إلى شجرة البناء
 * ولا تُثبت أكثرَ ممّا يُثبته هذا. والمقصودُ هنا **منطقُنا**: أيقرأ ما
 * كتب؟ أيتعامل مع الغياب والفساد؟ لا أن نُعيد اختبار مواصفة IndexedDB.
 *
 * ★ ويُخزَّن الكائنُ بمرجعه لا بنسخة.
 *
 *   وهذا مقصود: `CryptoKey` حقيقيٌّ يعود `CryptoKey` حقيقيًّا، فيبقى
 *   تأكيدُ «المفتاحُ لا يُصدَّر بعد القراءة» على مفتاحٍ حقيقيّ. ونسخةٌ
 *   بنيويّةٌ مقلّدةٌ كانت ستُحوّله إلى كائنٍ عاديّ فيسقط التأكيدُ لسببٍ خطأ.
 */

interface StoreState {
  data: Map<string, unknown>;
}

type RequestLike<T> = {
  result: T;
  error: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onupgradeneeded?: (() => void) | null;
  onblocked?: (() => void) | null;
};

function settle<T>(request: RequestLike<T>, run: () => T): void {
  queueMicrotask(() => {
    try {
      request.result = run();
      request.onsuccess?.();
    } catch (e) {
      request.error = e;
      request.onerror?.();
    }
  });
}

export interface MemoryIndexedDb {
  factory: IDBFactory;
  /** ما بداخل المخزن الآن — للتفتيش في التأكيدات */
  dump(): Record<string, unknown>;
  /** يزرع محتوًى فاسدًا لاختبار مسارات الفشل */
  seed(key: string, value: unknown): void;
  /** يزرع مخزنًا **آخر** بلا مخزننا — يُحاكي قاعدةً سبقتنا بالاسم نفسِه */
  seedForeignStore(name: string): void;
  /** كم مرّةً فُتحت القاعدة — لإثبات أنّ الإصلاحَ محاولةٌ واحدة لا حلقة */
  opens: number;
  openFailures: number;
}

export function createMemoryIndexedDb(options: { failOpen?: boolean } = {}): MemoryIndexedDb {
  const stores = new Map<string, StoreState>();
  let dbVersion = 0;
  const state: MemoryIndexedDb = {
    factory: null as unknown as IDBFactory,
    dump: () => Object.fromEntries(stores.get("pairing")?.data ?? new Map()),
    seed: (key, value) => {
      if (!stores.has("pairing")) stores.set("pairing", { data: new Map() });
      (stores.get("pairing") as StoreState).data.set(key, value);
    },
    seedForeignStore: (name) => { stores.set(name, { data: new Map() }); dbVersion = 1; },
    opens: 0,
    openFailures: 0,
  };

  const makeStore = (name: string) => {
    const store = stores.get(name) as StoreState;
    return {
      get(key: string) {
        const req: RequestLike<unknown> = { result: undefined, error: null, onsuccess: null, onerror: null };
        settle(req, () => store.data.get(key));
        return req;
      },
      put(value: unknown, key: string) {
        const req: RequestLike<unknown> = { result: undefined, error: null, onsuccess: null, onerror: null };
        settle(req, () => { store.data.set(key, value); return key; });
        return req;
      },
      delete(key: string) {
        const req: RequestLike<unknown> = { result: undefined, error: null, onsuccess: null, onerror: null };
        settle(req, () => { store.data.delete(key); return undefined; });
        return req;
      },
    };
  };

  const db = {
    get version() { return dbVersion; },
    objectStoreNames: { contains: (n: string) => stores.has(n) },
    createObjectStore: (n: string) => { stores.set(n, { data: new Map() }); return makeStore(n); },
    /**
     * ★ ومعاملةٌ لها دورةُ حياة، لا مجرّدُ ممرٍّ إلى المخزن.
     *
     *   الشيفرةُ المُختبَرة تنتظر `complete` على الكتابة لا `success` على
     *   الطلب — لأنّ الأولى تعني «كُتب» والثانية «قُبل». فمقلّدٌ لا يُطلق
     *   `complete` يجعل كلَّ كتابةٍ تتعلّق إلى الأبد، ومقلّدٌ يُطلقه قبل
     *   الطلب يُخفي بالضبط العطبَ الذي يحرسه ذلك الانتظار.
     */
    transaction: (n: string) => {
      const tx: {
        oncomplete: (() => void) | null;
        onabort: (() => void) | null;
        onerror: (() => void) | null;
        error: unknown;
        objectStore: () => ReturnType<typeof makeStore>;
      } = {
        oncomplete: null, onabort: null, onerror: null, error: null,
        objectStore: () => {
          const store = makeStore(n);
          /** يُطلق `complete` بعد أن يستقرّ الطلبُ الأخير في هذه المعاملة */
          const wrap = <T,>(req: RequestLike<T>) => {
            const original = req.onsuccess;
            Object.defineProperty(req, "onsuccess", {
              configurable: true,
              set(handler: (() => void) | null) {
                (req as { _h?: (() => void) | null })._h = handler;
              },
              get() {
                return () => {
                  (req as { _h?: (() => void) | null })._h?.();
                  queueMicrotask(() => tx.oncomplete?.());
                };
              },
            });
            void original;
            return req;
          };
          return {
            get: (k: string) => wrap(store.get(k)),
            put: (v: unknown, k: string) => wrap(store.put(v, k)),
            delete: (k: string) => wrap(store.delete(k)),
          } as ReturnType<typeof makeStore>;
        },
      };
      return tx;
    },
    close: () => { /* لا مورد يُحرّر */ },
  };

  state.factory = {
    /**
     * ★ ويحاكي قاعدةَ المتصفّح في النقطة التي أوقعت العطب:
     *
     *   `onupgradeneeded` لا يقع إلّا حين تكون النسخةُ المطلوبةُ **أعلى**
     *   من القائمة. فقاعدةٌ قائمةٌ بالنسخة نفسِها وبلا مخزننا تُفتح
     *   بنجاحٍ ولا يُنشَأ فيها شيء — وهذا ما وقع في المتصفّح الحقيقيّ.
     */
    open: (_name: string, version?: number) => {
      state.opens += 1;
      const req: RequestLike<unknown> = {
        result: db, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null,
      };
      queueMicrotask(() => {
        if (options.failOpen) {
          state.openFailures += 1;
          req.error = new Error("storage blocked");
          req.onerror?.();
          return;
        }
        const wanted = version ?? Math.max(dbVersion, 1);
        if (wanted > dbVersion) {
          dbVersion = wanted;
          req.onupgradeneeded?.();
        }
        req.onsuccess?.();
      });
      return req as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;

  return state;
}
