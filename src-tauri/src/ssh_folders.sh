# Runs after SSH authentication and lists folders for the workspace picker.
reply() {
    printf '\033]697;pigry;%s\007' "$1"
}

list_directory() (
    cd -P "$1" 2>/dev/null && [ -r . ] && [ -x . ] || {
        reply error
        exit 1
    }
    reply begin
    # NUL delimiters preserve punctuation and spaces in directory names.
    {
        printf '%s\000' "$PWD"
        for entry in ./* ./.[!.]* ./..?*; do
            if [ -d "$entry" ]; then
                printf '%s\000' "${entry#./}"
            fi
        done
    } | LC_ALL=C od -A n -v -t x1 | while IFS= read -r bytes; do
        reply "data;$bytes"
    done
    reply end
)

unset CDPATH
stty -echo -icanon icrnl min 1 time 0 || exit 1
reply ready
list_directory .
while IFS= read -r request; do
    case $request in
        'list /'*) list_directory "${request#list }" ;;
        *) reply error ;;
    esac
done
