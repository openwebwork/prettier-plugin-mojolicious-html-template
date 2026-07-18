#!/usr/bin/env perl

# Persistent worker used by src/mojo/perltidy.ts instead of shelling out to the `perltidy` binary once
# per marker/region - see the "perltidy worker" section of CLAUDE.local.md for why. Speaks newline-
# delimited JSON on stdin/stdout: each request is `{"id":N,"args":[...],"source":"..."}` on its own
# line, each response is `{"id":N,"ok":true|false,"output":"..."}` on its own line, always in the same
# order requests arrive in (this process handles one request at a time, so no explicit correlation
# beyond echoing `id` back is needed, but it's included anyway since it's essentially free and makes the
# protocol robust against a future change on either side).

use strict;
use warnings;

use Perl::Tidy;
use Mojo::JSON qw(decode_json encode_json true false);

$| = 1;

while (my $line = <STDIN>) {
    chomp $line;
    next if $line eq '';

    my $request = eval { decode_json($line) };
    next unless ref $request eq 'HASH';

    my $id     = $request->{id};
    my $args   = ref $request->{args} eq 'ARRAY' ? $request->{args} : [];
    my $source = defined $request->{source} ? $request->{source} : '';

    my $dest   = '';
    my $stderr = '';
    # `-se` (already always included by the caller) folds what would otherwise be a `.ERR` file into
    # `$stderr` instead - without it, a source snippet `perltidy` can't parse writes a real `perltidy.ERR`
    # file into this process's cwd, which would otherwise mean a malformed template leaves stray files
    # scattered in the user's project (verified empirically). `eval` guards against `Perl::Tidy::perltidy`
    # dying outright on a truly catastrophic input - it's meant to return a non-zero error code for
    # ordinary failures, but this worker must survive either way to keep serving later requests.
    my $ok = eval {
        my $error = Perl::Tidy::perltidy(
            source      => \$source,
            destination => \$dest,
            stderr      => \$stderr,
            argv        => $args,
        );
        !$error;
    };
    $ok = 0 if $@;

    print encode_json({ id => $id, ok => ($ok ? true : false), output => $dest }), "\n";
}
