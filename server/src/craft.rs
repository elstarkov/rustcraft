//! Crafting recipes. The list order is part of the wire protocol — clients
//! send a recipe by index — so client/src/recipes.js must list the same
//! recipes in the same order.

use crate::world::block;

pub struct Recipe {
    pub inputs: &'static [(u8, u32)],
    pub output: (u8, u32),
}

pub const RECIPES: &[Recipe] = &[
    Recipe { inputs: &[(block::LOG, 1)], output: (block::PLANKS, 4) },
    Recipe { inputs: &[(block::SAND, 1)], output: (block::GLASS, 1) },
    Recipe { inputs: &[(block::COAL_ORE, 1), (block::PLANKS, 1)], output: (block::TORCH, 4) },
];
