# Entry + module info of the Mishrin PSP test program (original code). The loader starts the main thread at e_entry.
	.set noreorder
	.section .rodata.sceModuleInfo, "a"
	.p2align 2
	.globl module_info
module_info:
	.hword 0x0000, 0x0101				# user mode, version 1.1
	.ascii "MishrinPSPTest"
	.space 27 - 14
	.byte 0
	.word _gp, __lib_ent_top, __lib_ent_bottom, __lib_stub_top, __lib_stub_bottom

	.section .lib.ent.top, "a"
	.globl __lib_ent_top
__lib_ent_top:
	.section .lib.ent.btm, "a"
	.globl __lib_ent_bottom
__lib_ent_bottom:

	.text
	.globl _start
	.type _start, @function
_start:
	la $gp, _gp
	addiu $sp, $sp, -16
	jal main
	nop
	jal sceKernelExitGame
	nop
1:	b 1b
	nop

# PSP system calls take arguments 5–8 in $t0–$t3 (EABI); clang's o32 would put them on the stack.
# create_thread(name, entry, priority, stack_size) → sceKernelCreateThread(..., attr = USER, option = NULL)
	.globl create_thread
	.type create_thread, @function
create_thread:
	lui $t0, 0x8000
	j sceKernelCreateThread
	move $t1, $zero
