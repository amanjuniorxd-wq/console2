# Entry point of the Mishrin PS3-class test program. LV2 starts the main thread at the function descriptor named by
# e_entry ({u32 code, u32 toc}) with r1 = stack; we set the ELFv2 TOC (.TOC.) ourselves and call main().
	.machine ppc64
	.section .data.opd, "aw"
	.p2align 3
	.globl _start_opd
_start_opd:
	.long _start, .TOC.

	.text
	.globl _start
	.type _start, @function
	.p2align 2
_start:
	lis 2, .TOC.@ha
	addi 2, 2, .TOC.@l
	li 0, 0
	stdu 0, -128(1)			# terminate the back chain
	bl main
	nop
	li 3, 0
	bl sys_process_exit
	nop
1:	b 1b

# int64 syscall(r3.., r11 = number)
	.globl lv2_usleep
	.type lv2_usleep, @function
lv2_usleep:
	li 11, 141			# sys_timer_usleep
	sc
	blr

# Process parameters (PT 0x60000001) and import/export table bounds (PT 0x60000002)
	.section .sys_proc_param, "a"
	.p2align 2
	.long 0x24, 0x13bcc5f6, 0x00009000, 0x00360001	# size, magic, version, sdk version 3.6
	.long 1001, 0x00040000, 0x00100000, 0, 0	# primary prio, stack 256 KiB, malloc page 1 MiB, ppc_seg, crash dump
	.section .sys_proc_prx_param, "a"
	.p2align 2
	.long 0x40, 0x1b434cec, 0x00000004, 0		# size, magic, version, unk0
	.long 0, 0					# libent start/end (no exports)
	.long __stub_start, __stub_end
	.short 1, 0
	.long 0
	.long 0, 0, 0, 0, 0, 0
