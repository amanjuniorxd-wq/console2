# Saffron Pulse — original PS1 test program for Mishrin P1 (public domain / MIT-0).
    .set noreorder
    .section .text.start
    .global _start
_start:
    mtc0  $zero, $12            # SR = 0: interrupts off, we poll hardware directly
    nop
    la    $sp, 0x801FFF00
    la    $gp, _gp
    la    $t0, __bss_start
    la    $t1, __bss_end
1:  sltu  $t2, $t0, $t1
    beqz  $t2, 2f
    nop
    sw    $zero, 0($t0)
    b     1b
    addiu $t0, $t0, 4
2:  jal   main
    nop
3:  b     3b
    nop
