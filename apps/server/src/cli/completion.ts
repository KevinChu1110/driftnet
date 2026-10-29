export const COMMANDS: Record<string, string[]> = {
  start: [],
  mcp: [],
  add: ["--note", "--url", "--token"],
  search: ["--folder", "--kind", "--view", "--limit", "--json", "--url", "--token"],
  open: ["--url", "--token"],
  export: ["--format", "--output", "--url", "--token"],
  import: ["--keep-folders", "--yes", "--url", "--token"],
  completion: [],
  status: ["--url", "--token"],
  help: [],
};
const GLOBAL = ["--help", "--version"];
const KINDS = "repo product video article post other";
const VIEWS = "inbox favorites trash";
const FORMATS = "json md vault";

export function completionScript(shell: string): string | undefined {
  const names = Object.keys(COMMANDS).join(" ");
  if (shell === "bash") {
    const cases = Object.entries(COMMANDS).filter(([, f]) => f.length).map(([c, f]) => `    ${c}) opts="${f.join(" ")}" ;;`).join("\n");
    return `# driftnet bash completion: eval "$(driftnet completion bash)"
_driftnet() {
  local cur prev cmd opts
  cur="\${COMP_WORDS[COMP_CWORD]}"; prev="\${COMP_WORDS[COMP_CWORD-1]}"; cmd="\${COMP_WORDS[1]}"
  case "$prev" in
    --kind) COMPREPLY=( $(compgen -W "${KINDS}" -- "$cur") ); return ;;
    --view) COMPREPLY=( $(compgen -W "${VIEWS}" -- "$cur") ); return ;;
    --format) COMPREPLY=( $(compgen -W "${FORMATS}" -- "$cur") ); return ;;
    completion) COMPREPLY=( $(compgen -W "bash zsh" -- "$cur") ); return ;;
    import|-o|--output) COMPREPLY=( $(compgen -f -- "$cur") ); return ;;
  esac
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${names} ${GLOBAL.join(" ")}" -- "$cur") ); return
  fi
  case "$cmd" in
${cases}
    *) opts="" ;;
  esac
  COMPREPLY=( $(compgen -W "$opts" -- "$cur") )
}
complete -F _driftnet driftnet
`;
  }
  if (shell === "zsh") {
    const cases = Object.entries(COMMANDS).filter(([, f]) => f.length).map(([c, f]) => `    ${c}) _values 'option' ${f.map((x) => `'${x}'`).join(" ")} ;;`).join("\n");
    return `#compdef driftnet
# driftnet zsh completion: eval "$(driftnet completion zsh)"
_driftnet() {
  if (( CURRENT == 2 )); then
    _values 'command' ${[...Object.keys(COMMANDS), ...GLOBAL].map((x) => `'${x}'`).join(" ")}
    return
  fi
  case "$words[CURRENT-1]" in
    --kind) _values 'kind' ${KINDS.split(" ").join(" ")}; return ;;
    --view) _values 'view' ${VIEWS}; return ;;
    --format) _values 'format' ${FORMATS}; return ;;
    completion) _values 'shell' bash zsh; return ;;
    import|-o|--output) _files; return ;;
  esac
  case "$words[2]" in
${cases}
  esac
}
compdef _driftnet driftnet
`;
  }
  return undefined;
}
