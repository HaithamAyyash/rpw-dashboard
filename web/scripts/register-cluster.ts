// Usage: npm run register-cluster -- --org al-ain --name CH-01 --nodes 1000-1031,2000
//        [--zone "Zone A"] [--lat 24.2] [--lon 55.7] [--uplink wifi|4g] [--label-prefix PLM-]
// A new cluster head's API key is printed once. Naming an existing one just adds nodes to it.
import { parseArgs } from "node:util";
import { parseLoraIds, registerCluster } from "@/lib/admin";

const { values } = parseArgs({
  options: {
    org: { type: "string" },
    name: { type: "string" },
    nodes: { type: "string" },
    zone: { type: "string" },
    lat: { type: "string" },
    lon: { type: "string" },
    uplink: { type: "string" },
    "label-prefix": { type: "string" },
  },
});

async function main() {
  if (!values.org || !values.name) throw new Error("Required: --org --name");
  const result = await registerCluster({
    orgSlug: values.org,
    name: values.name,
    farmZone: values.zone,
    lat: values.lat === undefined ? undefined : Number(values.lat),
    lon: values.lon === undefined ? undefined : Number(values.lon),
    uplink: values.uplink,
    loraIds: values.nodes ? parseLoraIds(values.nodes) : [],
    labelPrefix: values["label-prefix"],
  });
  console.log(`Cluster head ${values.name}: ${result.clusterId}`);
  console.log(`Nodes added: ${result.nodesAdded}`);
  if (result.apiKey) {
    console.log(`API key (shown once, store it on the Pi): ${result.apiKey}`);
  } else {
    console.log("Existing cluster head: API key unchanged.");
  }
}

main().catch((error: Error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
