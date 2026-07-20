#!/usr/bin/env perl

# Persistent worker used by src/mojo/perltidy.ts. Speaks newline-delimited JSON on stdin/stdout:
# `{"id":N,"args":[...],"source":"..."}` in, `{"id":N,"ok":true|false,"output":"..."}` out.

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
    # `-se` folds a would-be `.ERR` file into `$stderr` instead. `eval` guards against
    # `Perl::Tidy::perltidy` dying outright, so this worker survives to serve later requests either way.
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
