import * as assert from "assert";
import * as Benchmark from "benchmark";

import * as SchemaOrigin from "../schema";
import * as SchemaModified from "../schema_modified";

const NUMBER_OF_MAP_ELEMENTS = [100, 1000, 2000, 5000];

// ---------------- Intialize states -------------------------
class PlayerFromOrigin extends SchemaOrigin.Schema {
  @SchemaOrigin.type("string")
  userId = "missing";
}

class StateFromOrigin extends SchemaOrigin.Schema {
  @SchemaOrigin.type({ map: PlayerFromOrigin })
  players = new SchemaOrigin.MapSchema<PlayerFromOrigin>();
}

let stateFromOrigin = new StateFromOrigin();

class PlayerFromModified extends SchemaModified.Schema {
  @SchemaModified.type("string")
  userId = "missing";
}

class StateFromModified extends SchemaModified.Schema {
  @SchemaModified.type({ map: PlayerFromModified })
  players = new SchemaModified.MapSchema<PlayerFromModified>();
}

let stateFromModified = new StateFromModified();

// ----------------------------------------------------------------------------

// ---------------------- Run tests for different samples ---------------------------------------------------
for (const numberOfElements of NUMBER_OF_MAP_ELEMENTS) {
    let decodedFromEncodedOrigin = new StateFromOrigin();
    let decodedFromEncodedModified = new StateFromModified();
  let index = 0;
  
  console.log(`\nPreparing states with ${numberOfElements} elements: IN PROGRESS`);
  while (index < numberOfElements) {
    const key = index.toString();

    const playerFromOrigin = new PlayerFromOrigin();
    playerFromOrigin.userId = key;
    stateFromOrigin.players.set(key, playerFromOrigin);

    const playerFromModified = new PlayerFromModified();
    playerFromModified.userId = key;
    stateFromModified.players.set(key, playerFromModified);

    index++;
  }
  console.log(`Preparing states with ${numberOfElements} elements: DONE`);

  const encodedFromOrigin = stateFromOrigin.encodeAll();
  decodedFromEncodedOrigin.decode(encodedFromOrigin);

  const encodedFromModified = stateFromModified.encodeAll();
  decodedFromEncodedModified.decode(encodedFromModified);

  console.log(`Preparing decoded states from encoded states with ${numberOfElements} elements: DONE\n`);


  // -------------------------------------------------------------------

  const suite = new Benchmark.Suite();
  let reencodedFromOrigin;
  let reencodedFromModified;

  suite
    .add(`Re-Encode map schema using Origin Schema, elements: ${numberOfElements}`, function () {
      reencodedFromOrigin = decodedFromEncodedOrigin.encodeAll();
    })

    .add(`Re-Encode map schema using Modified Schema, elements: ${numberOfElements}`, function () {
      reencodedFromModified = decodedFromEncodedModified.encodeAll();
    })

    .on("cycle", function (event: any) {
      console.log(String(event.target));
    })

    .on("complete", function () {
      console.log("Fastest is " + this.filter("fastest").map("name"));
    })

    .run({ async: false });

    assert.deepEqual(reencodedFromOrigin, reencodedFromModified);

    console.log("---------------------------------------------------------");
}
