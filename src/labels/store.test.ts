import { describe, it, expect } from "vitest";
import { LabelStore } from "./store.js";
import type { Label } from "./types.js";

// 用独特的测试地址（合法十六进制，但模式罕见，避免与 10 万+ 真实标签冲突）
const ADDR_1 = "0x1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b" as `0x${string}`;
const ADDR_2 = "0x2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c" as `0x${string}`;
const ADDR_3 = "0x3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d" as `0x${string}`;
const ADDR_4 = "0x4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e" as `0x${string}`;
const ADDR_5 = "0x5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f" as `0x${string}`;

function makeLabel(overrides: Partial<Label> = {}): Label {
  return {
    address: ADDR_1,
    name: "Test Label",
    category: "exchange",
    source: "test",
    confidence: 0.8,
    ...overrides,
  };
}

describe("LabelStore", () => {
  describe("resolve", () => {
    it("未命中返回 null", () => {
      const store = new LabelStore();
      expect(store.resolve(ADDR_1)).toBeNull();
    });

    it("命中后返回标签", () => {
      const store = new LabelStore();
      const label = makeLabel();
      store.upsert(label);
      const result = store.resolve(ADDR_1);
      expect(result).not.toBeNull();
      expect(result!.name).toBe("Test Label");
      expect(result!.category).toBe("exchange");
    });

    it("地址大小写不敏感", () => {
      const store = new LabelStore();
      store.upsert(makeLabel({ address: ADDR_1.toUpperCase() as `0x${string}` }));
      expect(store.resolve(ADDR_1.toLowerCase() as `0x${string}`)).not.toBeNull();
      expect(store.resolve(ADDR_1.toUpperCase() as `0x${string}`)).not.toBeNull();
    });
  });

  describe("upsert", () => {
    it("新增标签", () => {
      const store = new LabelStore();
      const before = store.size();
      store.upsert(makeLabel());
      expect(store.size()).toBe(before + 1);
    });

    it("更新同地址标签（覆盖）", () => {
      const store = new LabelStore();
      store.upsert(makeLabel({ name: "Old Name", confidence: 0.5 }));
      store.upsert(makeLabel({ name: "New Name", confidence: 0.9 }));
      const result = store.resolve(ADDR_1);
      expect(result!.name).toBe("New Name");
      expect(result!.confidence).toBe(0.9);
    });

    it("置信度被 clamp 到 0–1", () => {
      const store = new LabelStore();
      store.upsert(makeLabel({ confidence: -0.5 }));
      expect(store.resolve(ADDR_1)!.confidence).toBe(0);

      store.upsert(makeLabel({ confidence: 1.5 }));
      expect(store.resolve(ADDR_1)!.confidence).toBe(1);

      store.upsert(makeLabel({ confidence: 0.5 }));
      expect(store.resolve(ADDR_1)!.confidence).toBe(0.5);
    });

    it("地址被统一转为小写存储", () => {
      const store = new LabelStore();
      store.upsert(
        makeLabel({ address: ADDR_1.toUpperCase() as `0x${string}` }),
      );
      const result = store.resolve(ADDR_1);
      expect(result!.address).toBe(ADDR_1.toLowerCase());
    });
  });

  describe("size", () => {
    it("返回数字类型", () => {
      const store = new LabelStore();
      expect(typeof store.size()).toBe("number");
    });

    it("新增标签后大小增加", () => {
      const store = new LabelStore();
      const before = store.size();
      store.upsert(makeLabel({ address: ADDR_4 }));
      store.upsert(makeLabel({ address: ADDR_5 }));
      expect(store.size()).toBe(before + 2);
    });
  });

  describe("bulkUpsert", () => {
    it("批量插入返回新增数量", () => {
      const store = new LabelStore();
      const before = store.size();
      const labels: Label[] = [
        makeLabel({ address: ADDR_1 }),
        makeLabel({ address: ADDR_2 }),
        makeLabel({ address: ADDR_3 }),
      ];
      const added = store.bulkUpsert(labels);
      expect(added).toBe(3);
      expect(store.size()).toBe(before + 3);
    });

    it("重复地址不计入新增", () => {
      const store = new LabelStore();
      const before = store.size();
      const labels: Label[] = [
        makeLabel({ address: ADDR_1 }),
        makeLabel({ address: ADDR_1, name: "Updated" }), // 同地址
      ];
      const added = store.bulkUpsert(labels);
      expect(added).toBe(1);
      expect(store.size()).toBe(before + 1);
    });
  });

  describe("dump", () => {
    it("导出所有标签数组", () => {
      const store = new LabelStore();
      const dumped = store.dump();
      expect(Array.isArray(dumped)).toBe(true);
      expect(dumped.length).toBe(store.size());
    });

    it("导出的标签包含所有字段", () => {
      const store = new LabelStore();
      store.upsert(makeLabel());
      const dumped = store.dump();
      const found = dumped.find((l) => l.address === ADDR_1.toLowerCase());
      expect(found).toBeDefined();
      expect(found!.name).toBe("Test Label");
      expect(found!.category).toBe("exchange");
      expect(found!.source).toBe("test");
      expect(found!.confidence).toBe(0.8);
    });
  });

  describe("profile（静态方法）", () => {
    it("组合 label 和 cluster", () => {
      const label = makeLabel();
      const cluster = {
        reason: "test",
        members: [ADDR_1, ADDR_2],
        confidence: 0.5,
      };
      const profile = LabelStore.profile(ADDR_1, label, cluster);
      expect(profile.address).toBe(ADDR_1);
      expect(profile.label).toEqual(label);
      expect(profile.cluster).toEqual(cluster);
    });

    it("label 和 cluster 都可为 null", () => {
      const profile = LabelStore.profile(ADDR_1, null, null);
      expect(profile.label).toBeNull();
      expect(profile.cluster).toBeNull();
    });
  });
});
