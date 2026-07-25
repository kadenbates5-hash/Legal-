import { describe, expect, it } from "vitest";
import { ResearchLibrary } from "../src/core/research-library.js";

describe("ResearchLibrary", () => {
  it("saves a reference and assigns it an id", () => {
    const library = new ResearchLibrary();
    const ref = library.save({ matterId: "m1", citation: "410 U.S. 113", title: "Roe v. Wade", savedBy: "p1" });
    expect(ref.id).toBe("ref_1");
    expect(library.get(ref.id)).toEqual(ref);
  });

  it("lists references by matter", () => {
    const library = new ResearchLibrary();
    library.save({ matterId: "m1", citation: "c1", title: "t1", savedBy: "p1" });
    library.save({ matterId: "m2", citation: "c2", title: "t2", savedBy: "p1" });
    expect(library.listByMatter("m1")).toHaveLength(1);
    expect(library.listByMatter("m1")[0]?.citation).toBe("c1");
  });

  it("deletes a reference", () => {
    const library = new ResearchLibrary();
    const ref = library.save({ matterId: "m1", citation: "c1", title: "t1", savedBy: "p1" });
    library.delete(ref.id);
    expect(library.get(ref.id)).toBeUndefined();
  });

  it("round-trips through toSnapshot/fromSnapshot, continuing id allocation", () => {
    const library = new ResearchLibrary();
    library.save({ matterId: "m1", citation: "c1", title: "t1", savedBy: "p1" });
    library.save({ matterId: "m1", citation: "c2", title: "t2", savedBy: "p1" });

    const restored = ResearchLibrary.fromSnapshot(library.toSnapshot());
    expect(restored.listAll()).toHaveLength(2);

    const next = restored.save({ matterId: "m1", citation: "c3", title: "t3", savedBy: "p1" });
    expect(next.id).toBe("ref_3");
  });
});
