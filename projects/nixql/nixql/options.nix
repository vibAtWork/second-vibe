# Extract NixOS option metadata under the given attribute paths:
# [{ path = [..]; type = { name; description; elem?; left?; right?; values?; }; files = [..]; }]
# `files` are the files that define the option's value on this host (definitionsWithLocations).
{ options, paths }:
let
  inherit (builtins) isAttrs attrNames concatMap tryEval removeAttrs map filter;

  typeJ = depth: t:
    let
      base = {
        name = t.name or "?";
        description = let d = tryEval (t.description or ""); in if d.success then d.value else "";
      };
      nt = t.nestedTypes or { };
      sub = k: if depth < 4 && nt ? ${k} then { ${k} = typeJ (depth + 1) nt.${k}; } else { };
      enumValues =
        if (t.name or "") == "enum" then
          let p = tryEval (t.functor.payload.values or t.functor.payload or [ ]); in
          if p.success && builtins.isList p.value then { values = filter (v: !(isAttrs v)) p.value; } else { }
        else { };
    in base // sub "elemType" // sub "left" // sub "right" // enumValues;

  filesOf = o:
    let r = tryEval (map (d: toString d.file) (o.definitionsWithLocations or [ ])); in
    if r.success then r.value else [ ];

  # Sub-options of submodule-typed options (settings = submodule, users.users = attrsOf submodule).
  # Elements of attrsOf/listOf get a "<name>" wildcard segment.
  subOptions = depth: prefix: files: t:
    let
      n = t.name or "";
      subs = let r = tryEval (t.getSubOptions [ ]); in if r.success then r.value else { };
    in
    if depth > 3 then [ ]
    else if n == "submodule" then walkSub depth prefix files subs
    else if builtins.elem n [ "attrsOf" "lazyAttrsOf" "listOf" "nullOr" ] && (t.nestedTypes or { }) ? elemType then
      subOptions depth (if n == "nullOr" then prefix else prefix ++ [ "<name>" ]) files t.nestedTypes.elemType
    else [ ];

  walkSub = depth: prefix: files: o:
    let r = tryEval o; in
    if !r.success then [ ]
    else if (o._type or null) == "option" then
      [{ path = prefix; type = typeJ 0 o.type; inherit files; }]
      ++ subOptions (depth + 1) prefix files o.type
    else if isAttrs o then
      concatMap (n: walkSub depth (prefix ++ [ n ]) files o.${n}) (attrNames (removeAttrs o [ "_module" ]))
    else [ ];

  walk = prefix: o:
    let r = tryEval o; in
    if !r.success then [ ]
    else if (o._type or null) == "option" then
      let files = filesOf o; in
      [{ path = prefix; type = typeJ 0 o.type; inherit files; }]
      ++ subOptions 0 prefix files o.type
    else if isAttrs o then
      concatMap (n: walk (prefix ++ [ n ]) o.${n}) (attrNames (removeAttrs o [ "_module" ]))
    else [ ];

  at = p: o: if p == [ ] then o else
    let h = builtins.head p; in if isAttrs o && o ? ${h} then at (builtins.tail p) o.${h} else null;

  # A selected path may point *inside* an option (e.g. users.users.alice): find the
  # deepest option on the way down, otherwise walk the subtree.
  forPath = p:
    let
      go = pre: rest: o:
        if (o._type or null) == "option" then walk pre o
        else if rest == [ ] then walk pre o
        else let h = builtins.head rest; in
          if isAttrs o && o ? ${h} then go (pre ++ [ h ]) (builtins.tail rest) o.${h} else [ ];
    in go [ ] p options;
in
concatMap forPath paths
