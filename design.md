# Chess Premove Game

We are building a chess practice game focused on vision. Each puzzle presents a position on a chessboard, and the player needs to perform a series of premoves that ends in checkmate, no matter how the opponent plays. Each puzzle has at least one solution.

## Game Mechanics

- There are a series of built-in puzzles. Players can work through them in order. The "Index" page shows a little badge for each numered puzzle with an indicator of completion.
- Players make premoves just like on Chess.com, either by dragging a piece or clicking the piece and then the destination. When a premove is made, we'll use the same visual feedback as Chess.com to indicate the move is queued. We use red squares to show the squares involved in the premove (both source and destination). The piece visually moves to the new place (it stops existing in the old place, it begins existing in the new place). It can be moved from it's new location. If it captured a piece, the old piece ceases to exist. If promotion occurs, the player is prompted to choose which piece they should promote to.
- Once the player is finished and they think their sequence of moves will lead to checkmate, they click a button to say they're done. Then the game plays about, about 1000ms per move.
- The player can "lose" in the following ways:
  - A premove ends up being illegal due to a move made by the opponent.
  - The opponent is not in checkmate at the end of their premoves
  - The player gets checkmated before completing their sequence of premoves.
- The player can "win" if either during the sequence of their premoves or at the end of their sequence, the opponent is checkmated and all moves were made legally.

## Opponent AI

- We use a available free chess engine to make moves, preferably stockfish. The engine should be downloaded and cached before the game can be played, with a nice bit of user interface to indicate if the engine is downloading. The engine chosen should be no larger than 50MB.
- The engine should be able to respond to moves quickly, ideally within 500ms, to maintain a smooth gameplay experience.
- The engine should be able to handle all standard chess rules, including castling, en passant, and promotion.

## Chess Rules Implementation

- We should ideally find an open source implementation that can represent a chess board and chess state. It should handle move validation, and special rules like castling, en passant, and promotion. It should also be able to detect check, checkmate, and stalemate conditions.
- The implementation should provide an easy way to generate all legal moves from a given position, which will be useful for both the opponent AI and for validating the player's premoves.
- It should also allow for easy manipulation of the board state, such as making and unmaking moves, to facilitate the simulation of move sequences.
- The implementation should be compatible with our AI engine, allowing the AI to determine it's next move.

## Implementation

- The game will be a web app. It should be entirely browser-based and should store persistent state in a users browser.
- The game should have a "frontend" and "backend". Both will be JavaScript.
- The frontend will handle the user interface, including displaying the chess board, handling user input for premoves, and showing the opponent's moves.
- The backend will handle the game logic, including validating moves, updating the game state, and communicating with the opponent AI engine.
- The backend should be developed first. We should be able to play the entirety of the game and validate the entirety of the behaviour just through the interface or API or the backend. This should be developed, validated and tested rigourously before developing a frontend.

## User interface
- First, the engine needs to be downloaded. Show a clear indication of that, including a progress bar.
- After that is done, we land on an "index" page showing all of the available levels. Only level 1 is unlocked to start. Each level on this index page is a square-ish icon indicating the number and it's current state, either locked, unlocked, or completed. Use colors.
- Clicking into a level takes the user to the chessboard with the level state loaded. They are prompted to make their premoves.
- There is a prominent button that says "I'm done premoving" or something like that. It unlocks after the first premove is made. Clicking it submits the premoves and begins the execution of the game.
- The interface should be similar to chess.com's default interface. We should ideally use similar icons for the chess pieces and the chess board should appear simiarly.
- The interface should provide clear feedback for invalid premoves (e.g. moving a piece to an illegal square, attempting to castle through check)
- After the user finishes and clicks the button to proceed, we begin executing the premoves in sequence, updating the board state and providing visual feedback for each move. The user always moves first, then the chess engine.
- The interface should indicate the outcome of the game once all premoves have been executed, such as victory, defeat, or draw. There should be celebration when we win and something more dejecting when we lose.
- Afterwards, there is an option to retry the level, go to the next level, or go back to the main menu.

## Testing
- It is significantly eaiser to test via javascript or APIs than to test things visually. For that reason, we should develop a comprehensive backend that can be tested automatically and that can be "played" through a series of backend interface calls. Testing the correctness of the application should not depend on any frontend components.
- Frontend is harder to test, but we should still do our best to test what is possible. Lean on the human developer when needed, they can give you feedback.

## Development

- A plan should be made indicating the structure of development.We should break the problem into smaller pieces and devise an order for development work.
- The application must not rely on any backend technology. It will be hosted in GitHub Pages or similar.
- The development should follow a modular approach, separating the game logic, user interface, and testing components to facilitate easier maintenance and testing.
- Each module should have a clear interface and be independently testable to ensure robustness and ease of debugging.
- The development should prioritize creating a solid and well-tested game logic module before focusing on the user interface, as the correctness of the game logic is critical for the overall functionality.
- Once the game logic is stable, the user interface can be developed to interact with it, ensuring that the visual representation accurately reflects the underlying game state.
- The development should include thorough testing at each stage, verifying that both the game logic and user interface behave as expected under various scenarios.
- Any bugs or inconsistencies discovered during testing should be promptly addressed, and regression tests should be added to prevent future occurrences.
- The development process should be iterative, with frequent reviews and adjustments based on testing results and user feedback to ensure a high-quality final product.
