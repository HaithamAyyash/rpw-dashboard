"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, type Page, type Tree } from "@/lib/ui/api";
import { useCurrentOrg } from "./OrgContext";
import { inputClass } from "./States";

/** A search box for choosing a tree; works with thousands of them. */
export function NodePicker({
  value,
  allLabel,
  onChange,
}: {
  value: string;
  allLabel?: string;
  onChange: (nodeId: string, label: string) => void;
}) {
  const org = useCurrentOrg();
  const [text, setText] = useState("");
  const trees = useQuery({
    queryKey: ["node-picker", org.org_id, text],
    queryFn: () =>
      apiGet<Page<Tree>>(`/orgs/${org.org_id}/trees`, {
        q: text,
        page_size: 20,
      }),
    refetchInterval: false,
  });
  const listId = "node-picker-options";

  function choose(input: string) {
    setText(input);
    if (input === "" && allLabel) onChange("", "");
    const match = trees.data?.items.find((t) => optionLabel(t) === input);
    if (match) onChange(String(match.node_id), match.tree_label);
  }

  return (
    <>
      <input
        aria-label="Choose a tree"
        list={listId}
        value={text}
        onChange={(event) => choose(event.target.value)}
        placeholder={
          value ? "Search for another tree" : (allLabel ?? "Search trees")
        }
        className={`${inputClass} w-[210px]`}
      />
      <datalist id={listId}>
        {trees.data?.items.map((tree) => (
          <option key={tree.node_id} value={optionLabel(tree)} />
        ))}
      </datalist>
    </>
  );
}

function optionLabel(tree: Tree): string {
  return `${tree.tree_label} (LoRa ${tree.lora_id})`;
}
