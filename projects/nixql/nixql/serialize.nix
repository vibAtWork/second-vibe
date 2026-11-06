# Safe Nix -> JSON-compatible value converter used by nixql.
#
# Full NixOS configs can't go straight through builtins.toJSON: they contain
# functions, derivations, `pkgs` (enormous), lazy throws for unset options, and
# in practice unbounded depth. This walks a value and replaces anything that is
# not plain data with a small marker object { __nixql = "<kind>"; ... }.
{ maxDepth ? 16, skip ? [ "_module" ] }:
let
  inherit (builtins) isAttrs isList isFunction isString isPath tryEval mapAttrs
    removeAttrs typeOf unsafeDiscardStringContext;

  marker = kind: extra: { __nixql = kind; } // extra;

  go = depth: v:
    let r = tryEval v; in
    if !r.success then marker "error" { }
    else
      let x = r.value; in
      if isFunction x then marker "function" { }
      else if isAttrs x then
        if (x.type or null) == "derivation" then
          let n = tryEval (x.name or "?"); in
          marker "derivation" { name = if n.success then unsafeDiscardStringContext n.value else "?"; }
        else if x ? _type && x._type != "nixql" then marker (toString x._type) { }
        else if depth >= maxDepth then marker "truncated" { }
        else mapAttrs (_: go (depth + 1)) (removeAttrs x skip)
      else if isList x then
        if depth >= maxDepth then marker "truncated" { }
        else map (go (depth + 1)) x
      else if isPath x then toString x
      else if isString x then unsafeDiscardStringContext x
      else x;
in
go 0
